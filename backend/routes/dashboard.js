const express = require('express');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { Op } = require('sequelize');
const { getBorrowerClient } = require('../helpers/borrower');

const router = express.Router();

// Get dashboard data
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const userRole = req.user?.role || 'user';
    const branchId = req.user?.branch_id || null;

    // For borrower role, get their client_id (by user_id or by email fallback)
    let clientId = null;
    if (userRole === 'borrower') {
      const client = await getBorrowerClient(userId, req.user?.email);
      if (client) {
        clientId = client.id;
      } else {
        return res.json({
          success: true,
          data: {
            statistics: {
              totalClients: 0,
              activeLoans: 0,
              totalSavings: 0,
              overdueLoans: 0,
              totalTransactions: 0,
              portfolioValue: 0,
              totalCollections: 0,
              lrd: { totalSavings: 0, outstandingLoans: 0, outstandingDues: 0, personalInterest: 0, generalInterest: 0, totalFines: 0 },
              usd: { totalSavings: 0, outstandingLoans: 0, outstandingDues: 0, personalInterest: 0, generalInterest: 0, totalFines: 0 }
            },
            recentLoans: [],
            recentTransactions: []
          }
        });
      }
    }

    let loansWhere = {};
    let savingsWhere = {};
    let transactionsWhere = {};
    let clientsWhere = {};
    if (userRole === 'borrower' && clientId) {
      // For borrowers, filter by their client_id (loans/savings/transactions)
      loansWhere.client_id = clientId;
      savingsWhere.client_id = clientId;
      transactionsWhere.client_id = clientId;
      // Clients table uses id, not client_id
      clientsWhere.id = clientId;
    } else if (branchId && userRole !== 'admin' && userRole !== 'general_manager') {
      loansWhere.branch_id = branchId;
      savingsWhere.branch_id = branchId;
      transactionsWhere.branch_id = branchId;
      clientsWhere.branch_id = branchId;
    }

      // Get statistics with currency separation (LRD and USD)
      let totalClients = 0;
      let activeLoans = 0;
      let overdueLoans = 0;
      let totalTransactions = 0;
      let recentLoans = [];
      let recentTransactions = [];

      // Currency-separated statistics
      let totalSavingsLRD = 0;
      let totalSavingsUSD = 0;
      let totalLoansLRD = 0;
      let totalLoansUSD = 0;
      let outstandingLoansLRD = 0;
      let outstandingLoansUSD = 0;
      let totalCollectionsLRD = 0;
      let totalCollectionsUSD = 0;
      let portfolioValueLRD = 0;
      let portfolioValueUSD = 0;
      
      // Financial metrics
      let totalDuesLRD = 0;
      let totalDuesUSD = 0;
      let outstandingDuesLRD = 0;
      let outstandingDuesUSD = 0;
      let clientsWithOutstandingDuesLRD = 0;
      let clientsWithOutstandingDuesUSD = 0;
      let clientsPaidDuesLRD = 0;
      let clientsPaidDuesUSD = 0;
      let totalFinesLRD = 0;
      let totalFinesUSD = 0;
      
      // Borrower-specific interest calculations
      let personalInterestLRD = 0;
      let personalInterestUSD = 0;
      let generalInterestLRD = 0;
      let generalInterestUSD = 0;

      try {
        // Fetch data with DB-side aggregation to avoid large in-memory scans.
        const [clientsCount, allLoans, allSavings, allClients, loansList, transactionsList] = await Promise.all([
          db.Client.count({ where: clientsWhere }).catch(() => 0),
          db.Loan.findAll({ 
            where: loansWhere,
            attributes: ['id', 'currency', 'amount', 'total_amount', 'outstanding_balance', 'status']
          }).catch(() => []),
          db.SavingsAccount.findAll({ 
            where: { 
              ...savingsWhere,
              status: 'active'
            },
            attributes: ['id', 'currency', 'balance']
          }).catch(() => []),
          db.Client.findAll({
            where: clientsWhere,
            attributes: ['id', 'total_dues', 'dues_currency']
          }).catch(() => []),
          db.Loan.findAll({
            where: loansWhere,
            include: [
              { model: db.Client, as: 'client', required: false, attributes: ['id', 'first_name', 'last_name', 'client_number'] },
              { model: db.Branch, as: 'branch', required: false, attributes: ['id', 'name'] }
            ],
            attributes: ['id', 'loan_number', 'amount', 'total_amount', 'total_paid', 'outstanding_balance', 'status', 'currency', 'createdAt'],
            order: [['createdAt', 'DESC']],
            limit: userRole === 'borrower' ? 20 : 5
          }).catch(() => []),
          db.Transaction.findAll({
            where: transactionsWhere,
            include: [
              { model: db.Client, as: 'client', required: false, attributes: ['id', 'first_name', 'last_name'] },
              { model: db.Loan, as: 'loan', required: false, attributes: ['id', 'loan_number'] },
              { model: db.SavingsAccount, as: 'savingsAccount', required: false, attributes: ['id', 'account_number'] }
            ],
            attributes: ['id', 'transaction_number', 'type', 'amount', 'currency', 'transaction_date', 'description', 'status', 'createdAt'],
            order: [['transaction_date', 'DESC'], ['createdAt', 'DESC']],
            limit: userRole === 'borrower' ? 50 : 10
          }).catch(() => [])
        ]);

        totalClients = clientsCount || 0;
        recentLoans = loansList || [];
        recentTransactions = transactionsList || [];
        
        // Calculate currency-separated totals
        allLoans.forEach(loan => {
          const currency = loan.currency || 'USD';
          const amount = parseFloat(loan.amount || 0);
          const outstanding = parseFloat(loan.outstanding_balance ?? loan.total_amount ?? loan.amount ?? 0);
          
          if (loan.status === 'active' || loan.status === 'disbursed' || loan.status === 'overdue') {
            if (currency === 'LRD') {
              totalLoansLRD += amount;
              outstandingLoansLRD += outstanding;
              portfolioValueLRD += outstanding;
            } else {
              totalLoansUSD += amount;
              outstandingLoansUSD += outstanding;
              portfolioValueUSD += outstanding;
            }
          }
        });
        
        activeLoans = allLoans.filter(l => l.status === 'active' || l.status === 'disbursed').length;
        overdueLoans = allLoans.filter(l => l.status === 'overdue').length;
        
        // Calculate currency-separated savings
        allSavings.forEach(saving => {
          const currency = saving.currency || 'USD';
          const balance = parseFloat(saving.balance || 0);
          if (currency === 'LRD') {
            totalSavingsLRD += balance;
          } else {
            totalSavingsUSD += balance;
          }
        });
        
        const txWhereBase = { ...transactionsWhere, status: 'completed' };
        const [
          txCount,
          collectionsLrd,
          collectionsUsd,
          finesLrd,
          finesUsd,
          borrowerPersonalLrd,
          borrowerPersonalUsd,
          borrowerGeneralLrd,
          borrowerGeneralUsd,
          duesPaidClientRows
        ] = await Promise.all([
          db.Transaction.count({ where: txWhereBase }).catch(() => 0),
          db.Transaction.sum('amount', { where: { ...txWhereBase, type: 'loan_payment', currency: 'LRD' } }).catch(() => 0),
          db.Transaction.sum('amount', { where: { ...txWhereBase, type: 'loan_payment', currency: { [Op.ne]: 'LRD' } } }).catch(() => 0),
          db.Transaction.sum('amount', { where: { ...txWhereBase, type: { [Op.in]: ['penalty', 'fee'] }, currency: 'LRD' } }).catch(() => 0),
          db.Transaction.sum('amount', { where: { ...txWhereBase, type: { [Op.in]: ['penalty', 'fee'] }, currency: { [Op.ne]: 'LRD' } } }).catch(() => 0),
          userRole === 'borrower'
            ? db.Transaction.sum('amount', { where: { ...txWhereBase, type: 'personal_interest_payment', currency: 'LRD' } }).catch(() => 0)
            : Promise.resolve(0),
          userRole === 'borrower'
            ? db.Transaction.sum('amount', { where: { ...txWhereBase, type: 'personal_interest_payment', currency: { [Op.ne]: 'LRD' } } }).catch(() => 0)
            : Promise.resolve(0),
          userRole === 'borrower'
            ? db.Transaction.sum('amount', { where: { ...txWhereBase, type: 'general_interest', currency: 'LRD' } }).catch(() => 0)
            : Promise.resolve(0),
          userRole === 'borrower'
            ? db.Transaction.sum('amount', { where: { ...txWhereBase, type: 'general_interest', currency: { [Op.ne]: 'LRD' } } }).catch(() => 0)
            : Promise.resolve(0),
          db.Transaction.findAll({
            where: { ...txWhereBase, type: 'due_payment' },
            attributes: ['client_id'],
            group: ['client_id']
          }).catch(() => [])
        ]);

        totalTransactions = txCount || 0;
        totalCollectionsLRD = parseFloat(collectionsLrd || 0);
        totalCollectionsUSD = parseFloat(collectionsUsd || 0);
        totalFinesLRD = parseFloat(finesLrd || 0);
        totalFinesUSD = parseFloat(finesUsd || 0);
        personalInterestLRD = parseFloat(borrowerPersonalLrd || 0);
        personalInterestUSD = parseFloat(borrowerPersonalUsd || 0);
        generalInterestLRD = parseFloat(borrowerGeneralLrd || 0);
        generalInterestUSD = parseFloat(borrowerGeneralUsd || 0);

        const duesPaidClientSet = new Set((duesPaidClientRows || []).map(r => Number(r.client_id)));
        
        // Calculate currency-separated dues
        allClients.forEach(client => {
          const duesCurrency = client.dues_currency || 'USD';
          const totalDues = parseFloat(client.total_dues || 0);
          
          if (totalDues < 0) { // Outstanding dues (negative)
            if (duesCurrency === 'LRD') {
              totalDuesLRD += totalDues;
              outstandingDuesLRD += Math.abs(totalDues);
              clientsWithOutstandingDuesLRD++;
            } else {
              totalDuesUSD += totalDues;
              outstandingDuesUSD += Math.abs(totalDues);
              clientsWithOutstandingDuesUSD++;
            }
          } else if (totalDues === 0) {
            // Client has paid all dues - check if they had dues before
            if (duesPaidClientSet.has(Number(client.id))) {
              if (duesCurrency === 'LRD') {
                clientsPaidDuesLRD++;
              } else {
                clientsPaidDuesUSD++;
              }
            }
          }
        });
        
      } catch (error) {
        console.error('Error fetching dashboard statistics:', error);
        console.error('Error stack:', error.stack);
        // Continue with default values
      }

      const totalSavings = totalSavingsLRD + totalSavingsUSD;
      const portfolioValue = portfolioValueLRD + portfolioValueUSD;
      const totalCollections = totalCollectionsLRD + totalCollectionsUSD;

      // Get clients with outstanding dues (for admin dashboard) - separated by currency
      let clientsWithDuesLRD = [];
      let clientsWithDuesUSD = [];
      if (userRole === 'admin' || userRole === 'finance' || userRole === 'general_manager' || userRole === 'head_micro_loan' || userRole === 'supervisor') {
        try {
          const allClientsWithDues = await db.Client.findAll({
            where: {
              total_dues: { [Op.lt]: 0 } // Negative values indicate outstanding dues
            },
            attributes: ['id', 'client_number', 'first_name', 'last_name', 'email', 'total_dues', 'dues_currency'],
            order: [['total_dues', 'ASC']], // Most negative first (most outstanding)
            limit: 50 // Get more to separate by currency
          });
          
          clientsWithDuesLRD = allClientsWithDues.filter(c => (c.dues_currency || 'USD') === 'LRD').slice(0, 10);
          clientsWithDuesUSD = allClientsWithDues.filter(c => (c.dues_currency || 'USD') === 'USD').slice(0, 10);
        } catch (error) {
          console.error('Error fetching clients with dues:', error);
        }
      }

    res.json({
      success: true,
      data: {
        statistics: {
          totalClients: totalClients || 0,
          activeLoans: activeLoans || 0,
          totalSavings: totalSavings,
          overdueLoans: overdueLoans || 0,
          totalTransactions: totalTransactions || 0,
          portfolioValue: portfolioValue,
          totalCollections: totalCollections,
          // Currency-separated totals
          lrd: {
            totalSavings: totalSavingsLRD,
            totalLoans: totalLoansLRD,
            outstandingLoans: outstandingLoansLRD,
            portfolioValue: portfolioValueLRD,
            totalCollections: totalCollectionsLRD,
            totalDues: totalDuesLRD,
            outstandingDues: outstandingDuesLRD,
            monthlyDues: outstandingDuesLRD / 12,
            clientsWithOutstandingDues: clientsWithOutstandingDuesLRD,
            clientsPaidDues: clientsPaidDuesLRD,
            totalFines: totalFinesLRD,
            outstandingSavings: totalSavingsLRD, // Outstanding savings = total savings in LRD
            // Borrower-specific fields
            personalInterest: userRole === 'borrower' ? personalInterestLRD : 0,
            generalInterest: userRole === 'borrower' ? generalInterestLRD : 0
          },
          usd: {
            totalSavings: totalSavingsUSD,
            totalLoans: totalLoansUSD,
            outstandingLoans: outstandingLoansUSD,
            portfolioValue: portfolioValueUSD,
            totalCollections: totalCollectionsUSD,
            totalDues: totalDuesUSD,
            outstandingDues: outstandingDuesUSD,
            monthlyDues: outstandingDuesUSD / 12,
            clientsWithOutstandingDues: clientsWithOutstandingDuesUSD,
            clientsPaidDues: clientsPaidDuesUSD,
            totalFines: totalFinesUSD,
            outstandingSavings: totalSavingsUSD, // Outstanding savings = total savings in USD
            // Borrower-specific fields
            personalInterest: userRole === 'borrower' ? personalInterestUSD : 0,
            generalInterest: userRole === 'borrower' ? generalInterestUSD : 0
          },
          // Overall totals (for backward compatibility)
          totalLoans: totalLoansLRD + totalLoansUSD,
          totalOutstandingLoans: outstandingLoansLRD + outstandingLoansUSD,
          totalOutstandingSavings: totalSavingsLRD + totalSavingsUSD
        },
        recentLoans,
        recentTransactions,
        clientsWithDues: {
          lrd: clientsWithDuesLRD || [],
          usd: clientsWithDuesUSD || [],
          all: [...(clientsWithDuesLRD || []), ...(clientsWithDuesUSD || [])].slice(0, 10) // Combined for backward compatibility
        }
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get real-time updates
router.get('/realtime', authenticate, async (req, res) => {
  try {
    const branchId = req.user?.branch_id || null;
    const userRole = req.user?.role || 'user';

    let whereClause = {};
    if (branchId && userRole !== 'admin' && userRole !== 'general_manager') {
      whereClause.branch_id = branchId;
    }

    const [pendingLoans, pendingClients, recentActivities] = await Promise.all([
      db.Loan.count({ where: { ...whereClause, status: 'pending' } }).catch(() => 0),
      db.Client.count({ where: { ...whereClause, kyc_status: 'pending' } }).catch(() => 0),
      db.Transaction.findAll({
        where: whereClause,
        include: [
          { model: db.Client, as: 'client', required: false, attributes: ['first_name', 'last_name'] }
        ],
        order: [['createdAt', 'DESC']],
        limit: 5
      }).catch(() => [])
    ]);

    res.json({
      success: true,
      data: {
        pendingLoans,
        pendingClients,
        recentActivities
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch real-time data',
      error: error.message
    });
  }
});

// Get historical data for charts
router.get('/historical', authenticate, async (req, res) => {
  try {
    const branchId = req.user?.branch_id || null;
    const userRole = req.user?.role || 'user';

    let whereClause = {};
    if (branchId && userRole !== 'admin' && userRole !== 'general_manager') {
      whereClause.branch_id = branchId;
    }

    // Get last 6 months of data (run month queries in parallel)
    const monthDates = Array.from({ length: 6 }, (_, idx) => {
      const i = 5 - idx;
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      return date;
    });

    const monthResults = await Promise.all(monthDates.map(async (date) => {
      const monthName = date.toLocaleString('default', { month: 'short' });
      const [portfolioResult, collectionsResult] = await Promise.all([
        db.Loan.sum('outstanding_balance', {
          where: {
            ...whereClause,
            status: { [Op.in]: ['active', 'disbursed'] },
            createdAt: { [Op.lte]: date }
          }
        }).catch(() => 0),
        db.Transaction.sum('amount', {
          where: {
            ...whereClause,
            type: 'loan_payment',
            createdAt: {
              [Op.gte]: new Date(date.getFullYear(), date.getMonth(), 1),
              [Op.lt]: new Date(date.getFullYear(), date.getMonth() + 1, 1)
            }
          }
        }).catch(() => 0)
      ]);

      return {
        monthName,
        portfolio: parseFloat(portfolioResult || 0),
        collections: parseFloat(collectionsResult || 0)
      };
    }));

    const months = monthResults.map(r => r.monthName);
    const portfolioValues = monthResults.map(r => r.portfolio);
    const collections = monthResults.map(r => r.collections);

    res.json({
      success: true,
      data: {
        months,
        portfolioValues,
        collections
      }
    });
  } catch (error) {
    console.error('Historical data error:', error);
    // Return empty data structure instead of error to prevent frontend crashes
    res.json({
      success: true,
      data: {
        months: [],
        portfolioValues: [],
        collections: []
      }
    });
  }
});

module.exports = router;

