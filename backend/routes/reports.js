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

// Client financial summary: From–To, currency USD|LRD, optional client_id, sort, grand totals.
router.get('/clients', async (req, res) => {
  try {
    const {
      from,
      to,
      from_datetime,
      to_datetime,
      currency: currencyRaw = 'USD',
      client_id: clientIdQuery,
      sort_by = 'client_number',
      sort_order = 'asc'
    } = req.query;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const branchId = req.user?.branch_id || null;
    const userRole = req.user?.role || 'user';

    const normalizeCur = (c) => (String(c || 'USD').toUpperCase() === 'LRD' ? 'LRD' : 'USD');
    const reportCurrency = normalizeCur(currencyRaw);
    if (reportCurrency !== 'USD' && reportCurrency !== 'LRD') {
      return res.status(400).json({ success: false, message: 'currency must be USD or LRD' });
    }

    const fromStr = from && String(from).trim().match(/^\d{4}-\d{2}-\d{2}/) ? String(from).trim().slice(0, 10) : null;
    const toStr = to && String(to).trim().match(/^\d{4}-\d{2}-\d{2}/) ? String(to).trim().slice(0, 10) : null;
    const fromDateTimeStr = from_datetime && String(from_datetime).trim()
      ? String(from_datetime).trim()
      : (fromStr ? `${fromStr}T00:00:00` : null);
    const toDateTimeStr = to_datetime && String(to_datetime).trim()
      ? String(to_datetime).trim()
      : (toStr ? `${toStr}T23:59:59.999` : null);

    let fromDate = fromDateTimeStr ? new Date(fromDateTimeStr) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let toDate = toDateTimeStr ? new Date(toDateTimeStr) : new Date();
    if (isNaN(fromDate.getTime())) fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (isNaN(toDate.getTime())) toDate = new Date();
    if (fromDate > toDate) {
      const swap = fromDate;
      fromDate = toDate;
      toDate = swap;
    }
    const fromNorm = fromDate.toISOString();
    const toNorm = toDate.toISOString();

    const clientWhere = { [Op.and]: [{ status: 'active' }] };
    if (branchId && userRole !== 'admin' && userRole !== 'general_manager') {
      clientWhere[Op.and].push({ branch_id: branchId });
    }
    const cid = clientIdQuery != null && String(clientIdQuery).trim() !== ''
      ? parseInt(String(clientIdQuery).trim(), 10)
      : NaN;
    if (!Number.isNaN(cid)) {
      clientWhere[Op.and].push({ id: cid });
    }

    const clients = await db.Client.findAll({
      where: clientWhere,
      attributes: ['id', 'client_number', 'first_name', 'last_name', 'total_dues', 'dues_currency'],
      order: [['client_number', 'ASC']]
    });

    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) {
      return res.json({
        success: true,
        data: {
          clients: [],
          grandTotals: {
            deposits: 0,
            interest_received: 0,
            dues_outstanding: 0,
            penalty_fines: 0,
            loan_outstanding: 0,
            total_take_home: 0
          },
          currency: reportCurrency,
          from: fromNorm,
          to: toNorm,
          sort_by: String(sort_by || 'client_number'),
          sort_order: String(sort_order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
          pagination: { total: 0, page, limit, pages: 1 }
        }
      });
    }

    const [savingsAccounts, loans, transactions] = await Promise.all([
      db.SavingsAccount.findAll({
        where: { client_id: { [Op.in]: clientIds }, status: { [Op.in]: ['active', 'pending'] } },
        attributes: ['client_id', 'currency', 'balance']
      }),
      db.Loan.findAll({
        where: { client_id: { [Op.in]: clientIds } },
        attributes: ['client_id', 'currency', 'outstanding_balance', 'status']
      }),
      db.Transaction.findAll({
        where: {
          client_id: { [Op.in]: clientIds },
          status: 'completed',
          transaction_date: { [Op.between]: [fromDate, toDate] }
        },
        attributes: ['client_id', 'type', 'currency', 'amount'],
        order: [['transaction_date', 'ASC']]
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

    const interestTypes = ['personal_interest_payment', 'general_interest', 'interest'];

    const rows = clients.map((client) => {
      const id = client.id;
      const cur = reportCurrency;
      const savingsList = (savingsByClient[id] || []).filter((s) => normalizeCur(s.currency) === cur);
      const savingsBalance = savingsList.reduce((s, a) => s + parseFloat(a.balance || 0), 0);

      const loanList = (loansByClient[id] || []).filter(
        (l) =>
          normalizeCur(l.currency) === cur &&
          ['active', 'disbursed', 'overdue'].includes(l.status)
      );
      const loanOutstanding = loanList.reduce((s, l) => s + parseFloat(l.outstanding_balance || 0), 0);

      const txList = txByClient[id] || [];
      const inCur = (t) => normalizeCur(t.currency) === cur;

      let deposits = 0;
      let interestReceived = 0;
      let penaltyFines = 0;
      txList.forEach((t) => {
        if (!inCur(t)) return;
        const amt = parseFloat(t.amount || 0);
        if (t.type === 'deposit') deposits += amt;
        if (interestTypes.includes(t.type)) interestReceived += amt;
        if (t.type === 'penalty' || t.type === 'fee') penaltyFines += amt;
      });

      const duesCur = normalizeCur(client.dues_currency);
      const totalDuesRaw = parseFloat(client.total_dues || 0);
      const duesOutstanding =
        duesCur === cur && totalDuesRaw < 0 ? Math.abs(totalDuesRaw) : 0;

      const totalTakeHome =
        savingsBalance + interestReceived - duesOutstanding - penaltyFines - loanOutstanding;

      const name = [client.first_name, client.last_name].filter(Boolean).join(' ') || '-';

      return {
        id: client.id,
        client_number: client.client_number,
        name,
        deposits,
        interest_received: interestReceived,
        dues_outstanding: duesOutstanding,
        penalty_fines: penaltyFines,
        loan_outstanding: loanOutstanding,
        total_take_home: totalTakeHome
      };
    });

    const sortDir = String(sort_order).toLowerCase() === 'desc' ? -1 : 1;
    const sortKey = String(sort_by || 'client_number').toLowerCase();
    const sorted = [...rows].sort((a, b) => {
      const getVal = (row) => {
        if (sortKey === 'name') return String(row.name || '').toLowerCase();
        if (sortKey === 'client_number') return String(row.client_number || '');
        if (sortKey === 'deposits') return Number(row.deposits || 0);
        if (sortKey === 'interest_received') return Number(row.interest_received || 0);
        if (sortKey === 'dues_outstanding') return Number(row.dues_outstanding || 0);
        if (sortKey === 'penalty_fines') return Number(row.penalty_fines || 0);
        if (sortKey === 'loan_outstanding') return Number(row.loan_outstanding || 0);
        if (sortKey === 'total_take_home') return Number(row.total_take_home || 0);
        return String(row.client_number || '');
      };
      const av = getVal(a);
      const bv = getVal(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return sortDir * String(av).localeCompare(String(bv));
      }
      return sortDir * ((av || 0) - (bv || 0));
    });

    const grandTotals = sorted.reduce(
      (acc, row) => {
        acc.deposits += row.deposits;
        acc.interest_received += row.interest_received;
        acc.dues_outstanding += row.dues_outstanding;
        acc.penalty_fines += row.penalty_fines;
        acc.loan_outstanding += row.loan_outstanding;
        acc.total_take_home += row.total_take_home;
        return acc;
      },
      {
        deposits: 0,
        interest_received: 0,
        dues_outstanding: 0,
        penalty_fines: 0,
        loan_outstanding: 0,
        total_take_home: 0
      }
    );

    const totalClients = sorted.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const paged = sorted.slice(start, end);

    res.json({
      success: true,
      data: {
        clients: paged,
        grandTotals,
        currency: reportCurrency,
        from: fromNorm,
        to: toNorm,
        sort_by: sortKey,
        sort_order: sortDir === 1 ? 'asc' : 'desc',
        pagination: {
          total: totalClients || 0,
          page,
          limit,
          pages: Math.max(1, Math.ceil((totalClients || 0) / limit))
        }
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
