const express = require('express');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { Op } = require('sequelize');
const { createRevenue, clientHasSavings, REVENUE_SOURCES } = require('../helpers/revenue');

const router = express.Router();

router.use(authenticate);

// New revenue model: revenue is stored in Revenue table only (no computed/estimated from repayments).
// Sources: microfinance_interest (100% from loans to clients without savings), dues (45%), general_interest (30%), penalty (50%).

// Get all revenue (admin, finance, general_manager, head_micro_loan, supervisor, micro_loan_officer)
router.get('/', authorize('admin', 'finance', 'general_manager', 'head_micro_loan', 'supervisor', 'micro_loan_officer'), async (req, res) => {
  try {
    const { startDate, endDate, source } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 100);
    const offset = (page - 1) * limit;

    let whereClause = {};

    if (startDate && endDate) {
      whereClause.revenue_date = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }

    if (source) {
      whereClause.source = source;
    }

    const { count, rows: revenues } = await db.Revenue.findAndCountAll({
      where: whereClause,
      include: [
        { model: db.Loan, as: 'loan', required: false, attributes: ['id', 'loan_number', 'loan_type', 'currency'] },
        { model: db.Transaction, as: 'transaction', required: false, attributes: ['id', 'transaction_number', 'currency'] },
        { model: db.User, as: 'creator', required: false, attributes: ['id', 'name', 'email'] }
      ],
      order: [['revenue_date', 'DESC']],
      limit,
      offset
    });

    // Totals from Revenue table only (no computed/legacy 20% interest)
    let totalRevenueLRD = 0;
    let totalRevenueUSD = 0;
    const revenueBySourceLRD = {};
    const revenueBySourceUSD = {};

    revenues.forEach(rev => {
      const currency = rev.currency || 'USD';
      const amount = parseFloat(rev.amount || 0);
      const src = rev.source || 'other';

      if (currency === 'LRD') {
        totalRevenueLRD += amount;
        revenueBySourceLRD[src] = (revenueBySourceLRD[src] || 0) + amount;
      } else {
        totalRevenueUSD += amount;
        revenueBySourceUSD[src] = (revenueBySourceUSD[src] || 0) + amount;
      }
    });

    const totalRevenue = totalRevenueLRD + totalRevenueUSD;
    const revenueBySource = {};
    Object.keys({ ...revenueBySourceLRD, ...revenueBySourceUSD }).forEach(src => {
      revenueBySource[src] = (revenueBySourceLRD[src] || 0) + (revenueBySourceUSD[src] || 0);
    });

    res.json({
      success: true,
      data: {
        revenues,
        summary: {
          totalRevenue: totalRevenue,
          revenueBySource,
          count: count,
          lrd: {
            totalRevenue: totalRevenueLRD,
            revenueBySource: revenueBySourceLRD
          },
          usd: {
            totalRevenue: totalRevenueUSD,
            revenueBySource: revenueBySourceUSD
          }
        },
        pagination: {
          total: count,
          page,
          limit,
          pages: Math.max(1, Math.ceil(count / limit))
        }
      }
    });
  } catch (error) {
    console.error('Get revenue error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch revenue',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get revenue summary/statistics (Revenue table only)
router.get('/summary', authorize('admin', 'finance', 'general_manager', 'head_micro_loan', 'supervisor', 'micro_loan_officer'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    let whereClause = {};
    if (startDate && endDate) {
      whereClause.revenue_date = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }

    const revenues = await db.Revenue.findAll({ where: whereClause });

    let totalRevenueLRD = 0;
    let totalRevenueUSD = 0;
    const revenueBySourceLRD = {};
    const revenueBySourceUSD = {};

    revenues.forEach(rev => {
      const currency = rev.currency || 'USD';
      const amount = parseFloat(rev.amount || 0);
      const src = rev.source || 'other';

      if (currency === 'LRD') {
        totalRevenueLRD += amount;
        revenueBySourceLRD[src] = (revenueBySourceLRD[src] || 0) + amount;
      } else {
        totalRevenueUSD += amount;
        revenueBySourceUSD[src] = (revenueBySourceUSD[src] || 0) + amount;
      }
    });

    const totalRevenue = totalRevenueLRD + totalRevenueUSD;
    const revenueBySource = {};
    Object.keys({ ...revenueBySourceLRD, ...revenueBySourceUSD }).forEach(src => {
      revenueBySource[src] = (revenueBySourceLRD[src] || 0) + (revenueBySourceUSD[src] || 0);
    });

    // Backward compatibility + new model: named buckets
    const microfinanceRevenue = (revenueBySource.microfinance_interest || 0) + (revenueBySource.loan_interest || 0);
    const duesRevenue = revenueBySource.dues || 0;
    const generalInterestRevenue = revenueBySource.general_interest || 0;
    const penaltyRevenue = revenueBySource.penalty || 0;
    const feesRevenue = revenueBySource.fees || 0;
    const savingsRevenue = revenueBySource.savings_interest || 0;
    const loanRevenue = microfinanceRevenue; // backward compat

    res.json({
      success: true,
      data: {
        totalRevenue: parseFloat(totalRevenue),
        loanRevenue: parseFloat(loanRevenue),
        savingsRevenue: parseFloat(savingsRevenue),
        feesRevenue: parseFloat(feesRevenue),
        microfinanceRevenue: parseFloat(microfinanceRevenue),
        duesRevenue: parseFloat(duesRevenue),
        generalInterestRevenue: parseFloat(generalInterestRevenue),
        penaltyRevenue: parseFloat(penaltyRevenue),
        revenueBySource,
        count: revenues.length,
        lrd: {
          totalRevenue: totalRevenueLRD,
          loanRevenue: (revenueBySourceLRD.microfinance_interest || 0) + (revenueBySourceLRD.loan_interest || 0),
          savingsRevenue: revenueBySourceLRD.savings_interest || 0,
          feesRevenue: revenueBySourceLRD.fees || 0,
          microfinanceRevenue: (revenueBySourceLRD.microfinance_interest || 0) + (revenueBySourceLRD.loan_interest || 0),
          duesRevenue: revenueBySourceLRD.dues || 0,
          generalInterestRevenue: revenueBySourceLRD.general_interest || 0,
          penaltyRevenue: revenueBySourceLRD.penalty || 0,
          revenueBySource: revenueBySourceLRD
        },
        usd: {
          totalRevenue: totalRevenueUSD,
          loanRevenue: (revenueBySourceUSD.microfinance_interest || 0) + (revenueBySourceUSD.loan_interest || 0),
          savingsRevenue: revenueBySourceUSD.savings_interest || 0,
          feesRevenue: revenueBySourceUSD.fees || 0,
          microfinanceRevenue: (revenueBySourceUSD.microfinance_interest || 0) + (revenueBySourceUSD.loan_interest || 0),
          duesRevenue: revenueBySourceUSD.dues || 0,
          generalInterestRevenue: revenueBySourceUSD.general_interest || 0,
          penaltyRevenue: revenueBySourceUSD.penalty || 0,
          revenueBySource: revenueBySourceUSD
        }
      }
    });
  } catch (error) {
    console.error('Get revenue summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch revenue summary',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Backfill revenue from older loans/repayments and transactions (admin only). Applies new revenue rules to historical data.
router.post('/backfill', authorize('admin'), async (req, res) => {
  try {
    const created = { microfinance_interest: 0, dues: 0, general_interest: 0, penalty: 0 };
    const userId = req.userId || null;

    // 1. LoanRepayments with interest that don't have Revenue yet: if client has no savings → 100% interest to revenue (microfinance)
    const repayments = await db.LoanRepayment.findAll({
      where: {
        status: 'completed',
        interest_amount: { [Op.gt]: 0 }
      },
      attributes: ['id', 'loan_id', 'transaction_id', 'interest_amount', 'payment_date'],
      include: [
        { model: db.Loan, as: 'loan', required: true, attributes: ['id', 'client_id', 'loan_number', 'currency'] }
      ]
    });
    const txnIdsWithRevenue = new Set(
      (await db.Revenue.findAll({ where: { transaction_id: { [Op.ne]: null } }, attributes: ['transaction_id'] }))
        .map(r => r.transaction_id)
    );
    for (const r of repayments) {
      if (r.transaction_id && txnIdsWithRevenue.has(r.transaction_id)) continue;
      const hasSavings = await clientHasSavings(r.loan?.client_id);
      if (!hasSavings && r.loan) {
        const amount = parseFloat(r.interest_amount || 0);
        const currency = r.loan.currency || 'USD';
        const revenueDate = r.payment_date ? new Date(r.payment_date) : new Date();
        const rev = await createRevenue({
          source: REVENUE_SOURCES.MICROFINANCE_INTEREST,
          amount,
          currency,
          transaction_id: r.transaction_id || null,
          loan_id: r.loan_id,
          description: `Backfill: microfinance loan interest from repayment for ${r.loan.loan_number}`,
          revenue_date: revenueDate,
          created_by: userId
        });
        if (rev) {
          created.microfinance_interest += 1;
          if (r.transaction_id) txnIdsWithRevenue.add(r.transaction_id);
        }
      }
    }

    // 2. due_payment transactions without Revenue → 45% to company
    const duePayments = await db.Transaction.findAll({
      where: { type: 'due_payment', status: 'completed' },
      attributes: ['id', 'amount', 'currency', 'transaction_date', 'client_id']
    });
    for (const t of duePayments) {
      const existing = await db.Revenue.findOne({ where: { transaction_id: t.id } });
      if (existing) continue;
      const amount = parseFloat(t.amount || 0) * 0.45;
      if (amount <= 0) continue;
      const rev = await createRevenue({
        source: REVENUE_SOURCES.DUES,
        amount,
        currency: t.currency || 'USD',
        transaction_id: t.id,
        description: `Backfill: dues revenue (45%) from client ${t.client_id}`,
        revenue_date: t.transaction_date || new Date(),
        created_by: userId
      });
      if (rev) created.dues += 1;
    }

    // 3. general_interest transactions without Revenue → 30%
    const generalInterestTxns = await db.Transaction.findAll({
      where: { type: 'general_interest', status: 'completed' },
      attributes: ['id', 'amount', 'currency', 'transaction_date', 'loan_id']
    });
    for (const t of generalInterestTxns) {
      const existing = await db.Revenue.findOne({ where: { transaction_id: t.id } });
      if (existing) continue;
      const amount = parseFloat(t.amount || 0) * 0.30;
      if (amount <= 0) continue;
      const rev = await createRevenue({
        source: REVENUE_SOURCES.GENERAL_INTEREST,
        amount,
        currency: t.currency || 'USD',
        transaction_id: t.id,
        loan_id: t.loan_id || null,
        description: 'Backfill: general interest revenue (30%)',
        revenue_date: t.transaction_date || new Date(),
        created_by: userId
      });
      if (rev) created.general_interest += 1;
    }

    // 4. penalty transactions without Revenue → 50%
    const penaltyTxns = await db.Transaction.findAll({
      where: { type: 'penalty', status: 'completed' },
      attributes: ['id', 'amount', 'currency', 'transaction_date', 'client_id']
    });
    for (const t of penaltyTxns) {
      const existing = await db.Revenue.findOne({ where: { transaction_id: t.id } });
      if (existing) continue;
      const amount = parseFloat(t.amount || 0) * 0.50;
      if (amount <= 0) continue;
      const rev = await createRevenue({
        source: REVENUE_SOURCES.PENALTY,
        amount,
        currency: t.currency || 'USD',
        transaction_id: t.id,
        description: `Backfill: penalty revenue (50%) from client ${t.client_id}`,
        revenue_date: t.transaction_date || new Date(),
        created_by: userId
      });
      if (rev) created.penalty += 1;
    }

    res.json({
      success: true,
      message: 'Revenue backfill completed',
      data: { created }
    });
  } catch (error) {
    console.error('Revenue backfill error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run revenue backfill',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;

