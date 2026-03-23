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
    const {
      from,
      to,
      from_datetime,
      to_datetime,
      month,
      currency = 'ALL',
      search,
      transaction_type,
      sort_by = 'last_transaction_date',
      sort_order = 'desc',
      include_empty = 'false'
    } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const branchId = req.user?.branch_id || null;
    const userRole = req.user?.role || 'user';

    const clientWhere = { [Op.and]: [] };
    if (branchId && userRole !== 'admin' && userRole !== 'general_manager') {
      clientWhere[Op.and].push({ branch_id: branchId });
    }
    // Only active, non-deleted clients in reports (exclude inactive, suspended, and soft-deleted)
    clientWhere[Op.and].push({ status: 'active' });
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

    const monthStr = month && String(month).trim().match(/^\d{4}-\d{2}$/) ? String(month).trim() : null;
    const fromStr = from && String(from).trim().match(/^\d{4}-\d{2}-\d{2}/) ? String(from).trim().slice(0, 10) : null;
    const toStr = to && String(to).trim().match(/^\d{4}-\d{2}-\d{2}/) ? String(to).trim().slice(0, 10) : null;
    const fromDateTimeStr = from_datetime && String(from_datetime).trim()
      ? String(from_datetime).trim()
      : (fromStr ? `${fromStr}T00:00:00` : null);
    const toDateTimeStr = to_datetime && String(to_datetime).trim()
      ? String(to_datetime).trim()
      : (toStr ? `${toStr}T23:59:59.999` : null);

    let fromDate;
    let toDate;
    if (monthStr) {
      const [y, m] = monthStr.split('-').map(v => parseInt(v, 10));
      fromDate = new Date(y, m - 1, 1, 0, 0, 0, 0);
      toDate = new Date(y, m, 0, 23, 59, 59, 999);
    } else {
      fromDate = fromDateTimeStr ? new Date(fromDateTimeStr) : new Date(0);
      toDate = toDateTimeStr ? new Date(toDateTimeStr) : new Date();
    }
    if (isNaN(fromDate.getTime())) fromDate = new Date(0);
    if (isNaN(toDate.getTime())) toDate = new Date();
    if (fromDate > toDate && !monthStr) {
      const swap = fromDate;
      fromDate = toDate;
      toDate = swap;
    }
    const fromNorm = fromDate.toISOString();
    const toNorm = toDate.toISOString();

    const requestedTxnTypes = String(transaction_type || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
    const allowedTxnTypes = ['deposit', 'withdrawal', 'due_payment', 'loan_payment', 'personal_interest_payment', 'general_interest', 'penalty', 'fee'];
    const txnTypes = requestedTxnTypes.length > 0
      ? requestedTxnTypes.filter(t => allowedTxnTypes.includes(t))
      : [];

    const includeEmptyClients = String(include_empty).toLowerCase() === 'true';

    const clients = await db.Client.findAll({
      where: clientWhere,
      attributes: ['id', 'client_number', 'first_name', 'last_name', 'total_dues', 'dues_currency'],
      order: [['client_number', 'ASC']]
    });

    const clientIds = clients.map(c => c.id);
    if (clientIds.length === 0) {
      return res.json({
        success: true,
        data: {
          clients: [],
          currency,
          month: monthStr,
          from: fromNorm,
          to: toNorm,
          sort_by: sort_by || 'last_transaction_date',
          sort_order: sort_order || 'desc',
          pagination: {
            total: 0,
            page,
            limit,
            pages: 1
          }
        }
      });
    }

    const [savingsAccounts, loans, transactions] = await Promise.all([
      db.SavingsAccount.findAll({
        where: { client_id: { [Op.in]: clientIds }, status: { [Op.in]: ['active', 'pending'] } },
        attributes: ['client_id', 'account_number', 'currency', 'balance']
      }),
      db.Loan.findAll({
        where: { client_id: { [Op.in]: clientIds } },
        attributes: ['client_id', 'currency', 'outstanding_balance', 'total_paid', 'status']
      }),
      db.Transaction.findAll({
        where: {
          client_id: { [Op.in]: clientIds },
          status: 'completed',
          transaction_date: { [Op.between]: [fromDate, toDate] },
          ...(txnTypes.length > 0 ? { type: { [Op.in]: txnTypes } } : {})
        },
        attributes: ['client_id', 'type', 'currency', 'amount', 'transaction_date'],
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
      const deposits = sumByCurrency(
        txList.filter(t => t.type === 'deposit'),
        'currency',
        'amount'
      );
      const withdrawals = sumByCurrency(
        txList.filter(t => t.type === 'withdrawal'),
        'currency',
        'amount'
      );
      const duePayments = sumByCurrency(
        txList.filter(t => t.type === 'due_payment'),
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

      // Per-client transactions in period (with date) for display in report
      const transactionsInPeriod = (txList || []).map(t => ({
        transaction_date: t.transaction_date,
        type: t.type,
        amount: parseFloat(t.amount || 0),
        currency: t.currency || 'USD'
      }));
      const firstTransactionDate = transactionsInPeriod.length > 0
        ? transactionsInPeriod[0].transaction_date
        : null;
      const lastTransactionDate = transactionsInPeriod.length > 0
        ? transactionsInPeriod[transactionsInPeriod.length - 1].transaction_date
        : null;

      if (currency === 'LRD') {
        return {
          id: client.id,
          client_number: client.client_number,
          savings_id: savingsIds,
          name,
          transaction_count: transactionsInPeriod.length,
          first_transaction_date: firstTransactionDate,
          last_transaction_date: lastTransactionDate,
          transactions: transactionsInPeriod,
          total_deposits: deposits.lrd,
          total_withdrawals: withdrawals.lrd,
          total_due_payments: duePayments.lrd,
          total_loan_payments: loanRepaymentInPeriod.lrd,
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
          transaction_count: transactionsInPeriod.length,
          first_transaction_date: firstTransactionDate,
          last_transaction_date: lastTransactionDate,
          transactions: transactionsInPeriod,
          total_deposits: deposits.usd,
          total_withdrawals: withdrawals.usd,
          total_due_payments: duePayments.usd,
          total_loan_payments: loanRepaymentInPeriod.usd,
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
        transaction_count: transactionsInPeriod.length,
        first_transaction_date: firstTransactionDate,
        last_transaction_date: lastTransactionDate,
        transactions: transactionsInPeriod,
        total_deposits_lrd: deposits.lrd,
        total_deposits_usd: deposits.usd,
        total_withdrawals_lrd: withdrawals.lrd,
        total_withdrawals_usd: withdrawals.usd,
        total_due_payments_lrd: duePayments.lrd,
        total_due_payments_usd: duePayments.usd,
        total_loan_payments_lrd: loanRepaymentInPeriod.lrd,
        total_loan_payments_usd: loanRepaymentInPeriod.usd,
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

    const filteredClients = includeEmptyClients
      ? clientsData
      : clientsData.filter(c => (c.transaction_count || 0) > 0);

    const sortDir = String(sort_order).toLowerCase() === 'asc' ? 1 : -1;
    const sortKey = String(sort_by || 'last_transaction_date').toLowerCase();
    const sortedClients = [...filteredClients].sort((a, b) => {
      const getVal = (row) => {
        if (sortKey === 'name') return String(row.name || '').toLowerCase();
        if (sortKey === 'client_number') return String(row.client_number || '');
        if (sortKey === 'transaction_count') return Number(row.transaction_count || 0);
        if (sortKey === 'last_transaction_date') return row.last_transaction_date ? new Date(row.last_transaction_date).getTime() : 0;
        if (sortKey === 'first_transaction_date') return row.first_transaction_date ? new Date(row.first_transaction_date).getTime() : 0;

        if (currency === 'ALL') {
          if (sortKey === 'total_deposits') return Number(row.total_deposits_lrd || 0) + Number(row.total_deposits_usd || 0);
          if (sortKey === 'total_withdrawals') return Number(row.total_withdrawals_lrd || 0) + Number(row.total_withdrawals_usd || 0);
          if (sortKey === 'total_due_payments') return Number(row.total_due_payments_lrd || 0) + Number(row.total_due_payments_usd || 0);
          if (sortKey === 'total_loan_payments') return Number(row.total_loan_payments_lrd || 0) + Number(row.total_loan_payments_usd || 0);
          if (sortKey === 'total_savings') return Number(row.total_savings_lrd || 0) + Number(row.total_savings_usd || 0);
          return Number(row.total_loan_payments_lrd || 0) + Number(row.total_loan_payments_usd || 0);
        }

        if (sortKey === 'total_deposits') return Number(row.total_deposits || 0);
        if (sortKey === 'total_withdrawals') return Number(row.total_withdrawals || 0);
        if (sortKey === 'total_due_payments') return Number(row.total_due_payments || 0);
        if (sortKey === 'total_loan_payments') return Number(row.total_loan_payments || 0);
        if (sortKey === 'total_savings') return Number(row.total_savings || 0);
        return Number(row.total_loan_payments || 0);
      };

      const av = getVal(a);
      const bv = getVal(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return sortDir * String(av).localeCompare(String(bv));
      }
      return sortDir * ((av || 0) - (bv || 0));
    });

    const totalClients = sortedClients.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const pagedClients = sortedClients.slice(start, end);

    res.json({
      success: true,
      data: {
        clients: pagedClients,
        currency: currency || 'ALL',
        month: monthStr,
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

