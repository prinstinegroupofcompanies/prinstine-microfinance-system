const express = require('express');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();

router.use(authenticate);

// New revenue model: revenue is stored in Revenue table only (no computed/estimated from repayments).
// Sources: microfinance_interest (100% from loans to clients without savings), dues (45%), general_interest (30%), penalty (50%).

// Get all revenue (admin, finance, general_manager, head_micro_loan, supervisor, micro_loan_officer)
router.get('/', authorize('admin', 'finance', 'general_manager', 'head_micro_loan', 'supervisor', 'micro_loan_officer'), async (req, res) => {
  try {
    const { startDate, endDate, source } = req.query;

    let whereClause = {};

    if (startDate && endDate) {
      whereClause.revenue_date = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }

    if (source) {
      whereClause.source = source;
    }

    const revenues = await db.Revenue.findAll({
      where: whereClause,
      include: [
        { model: db.Loan, as: 'loan', required: false, attributes: ['id', 'loan_number', 'loan_type', 'currency'] },
        { model: db.Transaction, as: 'transaction', required: false, attributes: ['id', 'transaction_number', 'currency'] },
        { model: db.User, as: 'creator', required: false, attributes: ['id', 'name', 'email'] }
      ],
      order: [['revenue_date', 'DESC']]
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
          count: revenues.length,
          lrd: {
            totalRevenue: totalRevenueLRD,
            revenueBySource: revenueBySourceLRD
          },
          usd: {
            totalRevenue: totalRevenueUSD,
            revenueBySource: revenueBySourceUSD
          }
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

module.exports = router;

