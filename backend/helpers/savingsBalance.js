const { Op, QueryTypes } = require('sequelize');

const BALANCE_TX_TYPES = ['deposit', 'withdrawal'];

/** Matches savings account creation (`backend/routes/savings.js`). */
const INITIAL_OPENING_PURPOSE = 'Initial account opening deposit';

function roundMoney(value) {
  return Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;
}

function isInitialOpeningDeposit(txn) {
  if (!txn || txn.type !== 'deposit') return false;
  if (txn.purpose === INITIAL_OPENING_PURPOSE) return true;
  const d = txn.description;
  return typeof d === 'string' && d.startsWith('Initial deposit for ');
}

/**
 * Expected balance from the ledger:
 * - All completed deposits and withdrawals for this savings account.
 * - Plus any pending *initial opening* deposit (same rules as account creation), because the
 *   account `balance` is set at open while that row may still be pending approval in some flows.
 * Other pending deposits/withdrawals are excluded (stored balance does not include them until completed).
 */
async function computeExpectedSavingsBalance(db, savingsAccountId, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const transactions = await db.Transaction.findAll({
    where: {
      savings_account_id: savingsAccountId,
      type: { [Op.in]: BALANCE_TX_TYPES },
      status: { [Op.in]: ['completed', 'pending'] }
    },
    attributes: ['type', 'amount', 'status', 'purpose', 'description'],
    ...queryOptions
  });

  const hasCompletedInitialOpening = transactions.some(
    (t) => t.status === 'completed' && isInitialOpeningDeposit(t)
  );

  let expected = 0;
  for (const txn of transactions) {
    const amount = parseFloat(txn.amount || 0);

    if (txn.status === 'completed') {
      if (txn.type === 'deposit') expected += amount;
      if (txn.type === 'withdrawal') expected -= amount;
      continue;
    }

    // Pending opening initial: included when the opening credit is not yet completed.
    // Skip if a completed opening row already exists (avoids double-count bad data).
    if (txn.status === 'pending' && isInitialOpeningDeposit(txn) && !hasCompletedInitialOpening) {
      expected += amount;
    }
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
 * One-shot bulk reconcile: recomputes every account balance from completed
 * deposits/withdrawals plus any pending initial-opening deposit (when no completed
 * opening row exists). Fast; corrects historical drift.
 */
async function bulkReconcileAllSavingsBalances(db, options = {}) {
  const sequelize = db.sequelize;
  const dialect = sequelize.getDialect();
  const txn = options.transaction;

  const signedAmountSql =
    dialect === 'postgres'
      ? `CASE WHEN type = 'deposit' THEN amount::numeric WHEN type = 'withdrawal' THEN -amount::numeric ELSE 0 END`
      : `CASE WHEN type = 'deposit' THEN CAST(amount AS REAL) WHEN type = 'withdrawal' THEN -CAST(amount AS REAL) ELSE 0 END`;

  const completionSumSql = `
    SELECT savings_account_id AS id,
      COALESCE(SUM(${signedAmountSql}), 0) AS expected_raw
    FROM transactions
    WHERE savings_account_id IS NOT NULL
      AND status = 'completed'
      AND type IN ('deposit', 'withdrawal')
      AND deleted_at IS NULL
    GROUP BY savings_account_id
  `;

  const pendingOpeningSql =
    dialect === 'postgres'
      ? `
    SELECT t.savings_account_id AS id,
      COALESCE(SUM(t.amount::numeric), 0) AS pending_initial_raw
    FROM transactions t
    WHERE t.savings_account_id IS NOT NULL
      AND t.deleted_at IS NULL
      AND t.type = 'deposit'
      AND t.status = 'pending'
      AND (
        t.purpose = :initialPurpose
        OR t.description LIKE 'Initial deposit for %'
      )
      AND NOT EXISTS (
        SELECT 1 FROM transactions o
        WHERE o.savings_account_id = t.savings_account_id
          AND o.deleted_at IS NULL
          AND o.type = 'deposit'
          AND o.status = 'completed'
          AND (
            o.purpose = :initialPurpose
            OR o.description LIKE 'Initial deposit for %'
          )
      )
    GROUP BY t.savings_account_id
  `
      : `
    SELECT t.savings_account_id AS id,
      COALESCE(SUM(CAST(t.amount AS REAL)), 0) AS pending_initial_raw
    FROM transactions t
    WHERE t.savings_account_id IS NOT NULL
      AND t.deleted_at IS NULL
      AND t.type = 'deposit'
      AND t.status = 'pending'
      AND (
        t.purpose = :initialPurpose
        OR t.description LIKE 'Initial deposit for %'
      )
      AND NOT EXISTS (
        SELECT 1 FROM transactions o
        WHERE o.savings_account_id = t.savings_account_id
          AND o.deleted_at IS NULL
          AND o.type = 'deposit'
          AND o.status = 'completed'
          AND (
            o.purpose = :initialPurpose
            OR o.description LIKE 'Initial deposit for %'
          )
      )
    GROUP BY t.savings_account_id
  `;

  const sumRows = await sequelize.query(completionSumSql, {
    type: QueryTypes.SELECT,
    transaction: txn
  });

  const pendingOpeningRows = await sequelize.query(pendingOpeningSql, {
    type: QueryTypes.SELECT,
    transaction: txn,
    replacements: { initialPurpose: INITIAL_OPENING_PURPOSE }
  });

  const expectedById = new Map();
  for (const row of sumRows) {
    const id = row.id;
    if (id == null) continue;
    expectedById.set(id, Math.max(0, roundMoney(row.expected_raw)));
  }
  for (const row of pendingOpeningRows) {
    const id = row.id;
    if (id == null) continue;
    const add = roundMoney(row.pending_initial_raw);
    const prev = expectedById.get(id) ?? 0;
    expectedById.set(id, Math.max(0, roundMoney(prev + add)));
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
  INITIAL_OPENING_PURPOSE,
  isInitialOpeningDeposit,
  computeExpectedSavingsBalance,
  reconcileSavingsAccountBalance,
  reconcileAllSavingsBalances,
  bulkReconcileAllSavingsBalances
};
