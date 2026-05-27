const { Op, QueryTypes } = require('sequelize');

const BALANCE_TX_TYPES = ['deposit', 'withdrawal'];

function roundMoney(value) {
  return Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;
}

async function computeExpectedSavingsBalance(db, savingsAccountId, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const transactions = await db.Transaction.findAll({
    where: {
      savings_account_id: savingsAccountId,
      type: { [Op.in]: BALANCE_TX_TYPES },
      status: 'completed'
    },
    attributes: ['type', 'amount'],
    ...queryOptions
  });

  let expected = 0;
  for (const txn of transactions) {
    const amount = parseFloat(txn.amount || 0);
    if (txn.type === 'deposit') expected += amount;
    if (txn.type === 'withdrawal') expected -= amount;
  }

  return Math.max(0, roundMoney(expected));
}

async function reconcileSavingsAccountBalance(db, savingsAccountId, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const account = await db.SavingsAccount.findByPk(savingsAccountId, queryOptions);
  if (!account) return null;

  const expectedBalance = await computeExpectedSavingsBalance(db, savingsAccountId, options);
  const currentBalance = roundMoney(account.balance);
  const changed = Math.abs(currentBalance - expectedBalance) >= 0.01;

  if (changed) {
    await account.update({ balance: expectedBalance }, queryOptions);
  }

  return {
    savings_account_id: account.id,
    account_number: account.account_number,
    currency: account.currency,
    current_balance: currentBalance,
    expected_balance: expectedBalance,
    changed
  };
}

/**
 * One-shot bulk reconcile: recomputes every account's balance from completed
 * deposit/withdrawal rows only (fast; corrects historical drift).
 */
async function bulkReconcileAllSavingsBalances(db, options = {}) {
  const sequelize = db.sequelize;
  const dialect = sequelize.getDialect();
  const txn = options.transaction;

  const signedAmountSql =
    dialect === 'postgres'
      ? `CASE WHEN type = 'deposit' THEN amount::numeric WHEN type = 'withdrawal' THEN -amount::numeric ELSE 0 END`
      : `CASE WHEN type = 'deposit' THEN CAST(amount AS REAL) WHEN type = 'withdrawal' THEN -CAST(amount AS REAL) ELSE 0 END`;

  const sumSql = `
    SELECT savings_account_id AS id,
      COALESCE(SUM(${signedAmountSql}), 0) AS expected_raw
    FROM transactions
    WHERE savings_account_id IS NOT NULL
      AND status = 'completed'
      AND type IN ('deposit', 'withdrawal')
      AND deleted_at IS NULL
    GROUP BY savings_account_id
  `;

  const sumRows = await sequelize.query(sumSql, {
    type: QueryTypes.SELECT,
    transaction: txn
  });

  const expectedById = new Map();
  for (const row of sumRows) {
    const id = row.id;
    if (id == null) continue;
    expectedById.set(id, Math.max(0, roundMoney(row.expected_raw)));
  }

  const accounts = await db.SavingsAccount.findAll({
    attributes: ['id', 'account_number', 'currency', 'balance'],
    transaction: txn
  });

  const mismatches = [];
  const updates = [];

  for (const account of accounts) {
    const expectedBalance = expectedById.get(account.id) ?? 0;
    const currentBalance = roundMoney(account.balance);
    const changed = Math.abs(currentBalance - expectedBalance) >= 0.01;
    if (changed) {
      updates.push(account.update({ balance: expectedBalance }, { transaction: txn }));
      mismatches.push({
        savings_account_id: account.id,
        account_number: account.account_number,
        currency: account.currency,
        previous_balance: currentBalance,
        expected_balance: expectedBalance
      });
    }
  }

  await Promise.all(updates);

  return {
    checked: accounts.length,
    corrected: mismatches.length,
    mismatches
  };
}

/** @deprecated Prefer bulkReconcileAllSavingsBalances; kept for compatibility */
async function reconcileAllSavingsBalances(db, options = {}) {
  return bulkReconcileAllSavingsBalances(db, options);
}

module.exports = {
  BALANCE_TX_TYPES,
  computeExpectedSavingsBalance,
  reconcileSavingsAccountBalance,
  reconcileAllSavingsBalances,
  bulkReconcileAllSavingsBalances
};
