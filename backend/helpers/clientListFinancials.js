const { Op } = require('sequelize');

const normalizeCur = (c) => (String(c || 'USD').toUpperCase() === 'LRD' ? 'LRD' : 'USD');

const emptyBucket = () => ({
  savings: 0,
  current_loans_amount: 0,
  outstanding_loans: 0,
  penalties: 0
});

/**
 * Batch-compute per-client financial figures for list views (USD / LRD buckets).
 */
async function getFinancialSummariesByClientIds(db, clientIds) {
  const map = {};
  if (!clientIds.length) return map;
  clientIds.forEach((id) => {
    map[id] = {
      USD: emptyBucket(),
      LRD: emptyBucket()
    };
  });

  const savingsRows = await db.SavingsAccount.findAll({
    where: { client_id: { [Op.in]: clientIds } },
    attributes: ['client_id', 'currency', [db.sequelize.fn('COALESCE', db.sequelize.fn('SUM', db.sequelize.col('balance')), 0), 'total']],
    group: ['client_id', 'currency'],
    raw: true
  });
  for (const row of savingsRows) {
    const cid = row.client_id;
    if (!map[cid]) continue;
    const cur = normalizeCur(row.currency);
    map[cid][cur].savings += parseFloat(row.total || 0);
  }

  const currentStatuses = ['pending', 'approved', 'disbursed', 'active', 'overdue'];
  const currentRows = await db.Loan.findAll({
    where: {
      client_id: { [Op.in]: clientIds },
      status: { [Op.in]: currentStatuses }
    },
    attributes: ['client_id', 'currency', [db.sequelize.fn('COALESCE', db.sequelize.fn('SUM', db.sequelize.col('amount')), 0), 'total']],
    group: ['client_id', 'currency'],
    raw: true
  });
  for (const row of currentRows) {
    const cid = row.client_id;
    if (!map[cid]) continue;
    const cur = normalizeCur(row.currency);
    map[cid][cur].current_loans_amount += parseFloat(row.total || 0);
  }

  const outstandingStatuses = ['disbursed', 'active', 'overdue'];
  const outRows = await db.Loan.findAll({
    where: {
      client_id: { [Op.in]: clientIds },
      status: { [Op.in]: outstandingStatuses },
      outstanding_balance: { [Op.gt]: 0 }
    },
    attributes: ['client_id', 'currency', [db.sequelize.fn('COALESCE', db.sequelize.fn('SUM', db.sequelize.col('outstanding_balance')), 0), 'total']],
    group: ['client_id', 'currency'],
    raw: true
  });
  for (const row of outRows) {
    const cid = row.client_id;
    if (!map[cid]) continue;
    const cur = normalizeCur(row.currency);
    map[cid][cur].outstanding_loans += parseFloat(row.total || 0);
  }

  const penRows = await db.Transaction.findAll({
    where: {
      client_id: { [Op.in]: clientIds },
      type: 'penalty'
    },
    attributes: ['client_id', 'currency', [db.sequelize.fn('COALESCE', db.sequelize.fn('SUM', db.sequelize.col('amount')), 0), 'total']],
    group: ['client_id', 'currency'],
    raw: true
  });
  for (const row of penRows) {
    const cid = row.client_id;
    if (!map[cid]) continue;
    const cur = normalizeCur(row.currency);
    map[cid][cur].penalties += parseFloat(row.total || 0);
  }

  const repayPenalties = await db.LoanRepayment.findAll({
    attributes: ['penalty_amount'],
    include: [
      {
        model: db.Loan,
        as: 'loan',
        required: true,
        attributes: ['client_id', 'currency'],
        where: { client_id: { [Op.in]: clientIds } }
      }
    ],
    where: { penalty_amount: { [Op.gt]: 0 } }
  });
  for (const r of repayPenalties) {
    const loan = r.loan;
    if (!loan) continue;
    const cid = loan.client_id;
    if (!map[cid]) continue;
    const cur = normalizeCur(loan.currency);
    map[cid][cur].penalties += parseFloat(r.penalty_amount || 0);
  }

  return map;
}

module.exports = { getFinancialSummariesByClientIds, normalizeCur };
