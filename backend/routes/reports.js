const express = require('express');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

router.use(authenticate);
router.use(authorize('admin', 'general_manager', 'branch_manager', 'micro_loan_officer', 'head_micro_loan', 'supervisor', 'finance'));

// Get financial report
router.get('/financial', async (req, res) => {
  try {
    // Placeholder for financial report logic
    res.json({
      success: true,
      data: { message: 'Financial report endpoint' }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to generate report',
      error: error.message
    });
  }
});

// Get client reports: list of all clients with ID#, Savings ID#, Name, total savings,
// personal interest, general interest, outstanding loan, loan repayment done, loan status,
// outstanding dues, total dues paid, penalty. Filters: from, to, currency (LRD, USD, ALL), search by name.
router.get('/clients', async (req, res) => {
  try {
    const { from, to, currency = 'ALL', search } = req.query;
    const branchId = req.user?.branch_id || null;
    const userRole = req.user?.role || 'user';

    const clientWhere = { [Op.and]: [] };
    if (branchId && userRole !== 'admin' && userRole !== 'general_manager') {
      clientWhere[Op.and].push({ branch_id: branchId });
    }
    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      clientWhere[Op.and].push({
        [Op.or]: [
          { first_name: { [Op.like]: term } },
          { last_name: { [Op.like]: term } },
          { client_number: { [Op.like]: term } },
          { email: { [Op.like]: term } }
        ]
      });
    }
    if (clientWhere[Op.and].length === 0) {
      clientWhere[Op.and].push({ id: { [Op.ne]: -1 } });
    }

    const fromDate = from ? new Date(from) : new Date(0);
    const toDate = to ? new Date(to) : new Date();
    if (isNaN(fromDate.getTime())) fromDate.setTime(0);
    if (isNaN(toDate.getTime())) toDate.setTime(Date.now());

    const transactionDateWhere = {
      transaction_date: { [Op.gte]: fromDate, [Op.lte]: toDate },
      status: 'completed'
    };

    const clients = await db.Client.findAll({
      where: clientWhere,
      attributes: ['id', 'client_number', 'first_name', 'last_name', 'total_dues', 'dues_currency'],
      order: [['client_number', 'ASC']],
      paranoid: false
    });

    const clientIds = clients.map(c => c.id);
    if (clientIds.length === 0) {
      return res.json({ success: true, data: { clients: [], currency } });
    }

    const [savingsAccounts, loans, transactions] = await Promise.all([
      db.SavingsAccount.findAll({
        where: { client_id: { [Op.in]: clientIds }, status: { [Op.in]: ['active', 'pending'] } },
        attributes: ['client_id', 'account_number', 'currency', 'balance'],
        paranoid: false
      }),
      db.Loan.findAll({
        where: { client_id: { [Op.in]: clientIds } },
        attributes: ['client_id', 'currency', 'outstanding_balance', 'total_paid', 'status'],
        paranoid: false
      }),
      db.Transaction.findAll({
        where: {
          client_id: { [Op.in]: clientIds },
          ...transactionDateWhere
        },
        attributes: ['client_id', 'type', 'currency', 'amount'],
        paranoid: false
      })
    ]);

    const byClient = (arr, key = 'client_id') => {
      const map = {};
      arr.forEach((item) => {
        const id = item[key];
        if (!map[id]) map[id] = [];
        map[id].push(item);
      });
      return map;
    };

    const savingsByClient = byClient(savingsAccounts);
    const loansByClient = byClient(loans);
    const txByClient = byClient(transactions);

    const sumByCurrency = (items, currencyKey, amountKey) => {
      const lrd = items.filter(i => (i[currencyKey] || 'USD') === 'LRD').reduce((s, i) => s + parseFloat(i[amountKey] || 0), 0);
      const usd = items.filter(i => (i[currencyKey] || 'USD') !== 'LRD').reduce((s, i) => s + parseFloat(i[amountKey] || 0), 0);
      return { lrd, usd };
    };

    const clientsData = clients.map((client) => {
      const cid = client.id;
      const savingsList = savingsByClient[cid] || [];
      const loanList = loansByClient[cid] || [];
      const txList = txByClient[cid] || [];

      const savingsIds = [...new Set(savingsList.map(s => s.account_number).filter(Boolean))].join(', ') || '-';
      const totalSavings = sumByCurrency(savingsList, 'currency', 'balance');

      const loanStatuses = [...new Set(loanList.map(l => l.status))].filter(Boolean);
      const primaryStatus = loanList.find(l => l.status === 'active' || l.status === 'disbursed' || l.status === 'overdue')?.status ||
        loanList.find(l => l.status === 'pending' || l.status === 'approved')?.status ||
        (loanStatuses[0] || '-');

      const outstandingLoan = sumByCurrency(
        loanList.filter(l => ['active', 'disbursed', 'overdue'].includes(l.status)),
        'currency',
        'outstanding_balance'
      );
      const totalPaidLoans = sumByCurrency(loanList, 'currency', 'total_paid');

      const loanRepaymentInPeriod = sumByCurrency(
        txList.filter(t => t.type === 'loan_payment'),
        'currency',
        'amount'
      );
      const personalInterest = sumByCurrency(
        txList.filter(t => t.type === 'personal_interest_payment'),
        'currency',
        'amount'
      );
      const generalInterest = sumByCurrency(
        txList.filter(t => t.type === 'general_interest'),
        'currency',
        'amount'
      );
      const duesPaid = sumByCurrency(
        txList.filter(t => t.type === 'due_payment'),
        'currency',
        'amount'
      );
      const penalty = sumByCurrency(
        txList.filter(t => t.type === 'penalty' || t.type === 'fee'),
        'currency',
        'amount'
      );

      const totalDuesRaw = parseFloat(client.total_dues || 0);
      const duesCurrency = client.dues_currency || 'USD';
      const outstandingDues = totalDuesRaw < 0 ? Math.abs(totalDuesRaw) : 0;
      const outstandingDuesLrd = duesCurrency === 'LRD' ? outstandingDues : 0;
      const outstandingDuesUsd = duesCurrency === 'USD' ? outstandingDues : 0;

      const name = [client.first_name, client.last_name].filter(Boolean).join(' ') || '-';

      if (currency === 'LRD') {
        return {
          id: client.id,
          client_number: client.client_number,
          savings_id: savingsIds,
          name,
          total_savings: totalSavings.lrd,
          personal_interest: personalInterest.lrd,
          general_interest: generalInterest.lrd,
          outstanding_loan: outstandingLoan.lrd,
          loan_repayment_done: loanRepaymentInPeriod.lrd,
          loan_status: primaryStatus,
          outstanding_dues: outstandingDuesLrd,
          total_dues_paid: duesPaid.lrd,
          penalty: penalty.lrd
        };
      }
      if (currency === 'USD') {
        return {
          id: client.id,
          client_number: client.client_number,
          savings_id: savingsIds,
          name,
          total_savings: totalSavings.usd,
          personal_interest: personalInterest.usd,
          general_interest: generalInterest.usd,
          outstanding_loan: outstandingLoan.usd,
          loan_repayment_done: loanRepaymentInPeriod.usd,
          loan_status: primaryStatus,
          outstanding_dues: outstandingDuesUsd,
          total_dues_paid: duesPaid.usd,
          penalty: penalty.usd
        };
      }
      return {
        id: client.id,
        client_number: client.client_number,
        savings_id: savingsIds,
        name,
        total_savings_lrd: totalSavings.lrd,
        total_savings_usd: totalSavings.usd,
        personal_interest_lrd: personalInterest.lrd,
        personal_interest_usd: personalInterest.usd,
        general_interest_lrd: generalInterest.lrd,
        general_interest_usd: generalInterest.usd,
        outstanding_loan_lrd: outstandingLoan.lrd,
        outstanding_loan_usd: outstandingLoan.usd,
        loan_repayment_done_lrd: loanRepaymentInPeriod.lrd,
        loan_repayment_done_usd: loanRepaymentInPeriod.usd,
        loan_status: primaryStatus,
        outstanding_dues_lrd: outstandingDuesLrd,
        outstanding_dues_usd: outstandingDuesUsd,
        total_dues_paid_lrd: duesPaid.lrd,
        total_dues_paid_usd: duesPaid.usd,
        penalty_lrd: penalty.lrd,
        penalty_usd: penalty.usd
      };
    });

    res.json({
      success: true,
      data: {
        clients: clientsData,
        currency: currency || 'ALL',
        from: fromDate.toISOString(),
        to: toDate.toISOString()
      }
    });
  } catch (error) {
    console.error('Client reports error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch client reports',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;

