const { Op } = require('sequelize');

const BALANCE_TX_TYPES = ['deposit', 'withdrawal'];

/** Matches savings account creation (`backend/routes/savings.js`). */
const INITIAL_OPENING_PURPOSE = 'Initial account opening deposit';

function roundMoney(value) {
  return Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeCurrency(currency) {
  return String(currency || 'USD').toUpperCase() === 'LRD' ? 'LRD' : 'USD';
}

function textLike(sequelize, value) {
  const dialect = sequelize?.getDialect?.() || 'postgres';
  return dialect === 'postgres' ? { [Op.iLike]: value } : { [Op.like]: value };
}

function isInitialOpeningDeposit(txn) {
  if (!txn || txn.type !== 'deposit') return false;
  if (txn.purpose === INITIAL_OPENING_PURPOSE) return true;
  const purpose = (txn.purpose || '').toLowerCase();
  const description = (txn.description || '').toLowerCase();
  if (purpose.includes('initial') && (purpose.includes('opening') || purpose.includes('deposit'))) {
    return true;
  }
  if (description.includes('initial deposit')) return true;
  if (description.startsWith('initial deposit for ')) return true;
  return false;
}

function openingDescriptionMatchesAccount(description, accountNumber) {
  if (!description || !accountNumber) return false;
  const d = description.toLowerCase();
  const num = String(accountNumber).toLowerCase();
  return d.includes(num) || d.startsWith('initial deposit for ');
}

function transactionMatchesAccount(txn, account) {
  if (!txn || !account) return false;
  if (txn.savings_account_id === account.id) return true;
  if (txn.savings_account_id && txn.savings_account_id !== account.id) return false;
  if (txn.client_id !== account.client_id) return false;
  if (normalizeCurrency(txn.currency) !== normalizeCurrency(account.currency)) return false;
  return openingDescriptionMatchesAccount(txn.description, account.account_number);
}

/**
 * Apply or reverse a completed deposit/withdrawal on the stored savings balance.
 */
async function applySavingsBalanceChange(db, savingsAccountId, type, amount, direction = 'apply', options = {}) {
  if (!savingsAccountId || !BALANCE_TX_TYPES.includes(type)) return;
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const account = await db.SavingsAccount.findByPk(savingsAccountId, queryOptions);
  if (!account || account.status !== 'active') return;

  const amt = parseFloat(amount || 0);
  if (!amt || amt <= 0) return;

  const current = parseFloat(account.balance || 0);
  const sign = direction === 'reverse' ? -1 : 1;
  let next = current;

  if (type === 'deposit') {
    next = current + sign * amt;
  } else if (type === 'withdrawal') {
    next = direction === 'reverse' ? current + amt : Math.max(0, current - amt);
  }

  await account.update({ balance: Math.max(0, roundMoney(next)) }, queryOptions);
}

async function getClientAccountsForCurrency(db, clientId, currency, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  return db.SavingsAccount.findAll({
    where: { client_id: clientId, currency: normalizeCurrency(currency) },
    attributes: ['id', 'client_id', 'account_number', 'currency', 'createdAt'],
    order: [['createdAt', 'ASC']],
    ...queryOptions
  });
}

/**
 * Pick which savings account an orphan client deposit belongs to.
 */
function pickAccountForOrphanDeposit(txn, accounts) {
  if (!accounts.length) return null;

  const desc = (txn.description || '').toLowerCase();
  const byNumber = accounts.find((a) => desc.includes(String(a.account_number).toLowerCase()));
  if (byNumber) return byNumber;

  if (isInitialOpeningDeposit(txn) || txn.purpose === INITIAL_OPENING_PURPOSE) {
    const byInitialDesc = accounts.find((a) => openingDescriptionMatchesAccount(txn.description, a.account_number));
    if (byInitialDesc) return byInitialDesc;
  }

  if (accounts.length === 1) return accounts[0];

  const txnTime = new Date(txn.transaction_date || txn.createdAt || 0).getTime();
  let best = accounts[0];
  let bestDiff = Math.abs(new Date(best.createdAt).getTime() - txnTime);
  for (const acct of accounts) {
    const diff = Math.abs(new Date(acct.createdAt).getTime() - txnTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = acct;
    }
  }
  return best;
}

/**
 * Link orphan deposit/withdrawal rows to the correct savings account (by client + currency).
 */
async function relinkOrphanSavingsTransactions(db, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const orphans = await db.Transaction.findAll({
    where: {
      savings_account_id: null,
      client_id: { [Op.ne]: null },
      type: { [Op.in]: BALANCE_TX_TYPES }
    },
    attributes: ['id', 'client_id', 'currency', 'description', 'purpose', 'transaction_date', 'createdAt', 'type'],
    ...queryOptions
  });

  const clientIds = [...new Set(orphans.map((t) => t.client_id).filter(Boolean))];
  const accountsByClient = new Map();

  for (const clientId of clientIds) {
    const accounts = await db.SavingsAccount.findAll({
      where: { client_id: clientId },
      attributes: ['id', 'client_id', 'account_number', 'currency', 'createdAt'],
      order: [['createdAt', 'ASC']],
      ...queryOptions
    });
    accountsByClient.set(clientId, accounts);
  }

  let linked = 0;
  for (const txn of orphans) {
    const accounts = (accountsByClient.get(txn.client_id) || []).filter(
      (a) => normalizeCurrency(a.currency) === normalizeCurrency(txn.currency)
    );
    const target = pickAccountForOrphanDeposit(txn, accounts);
    if (target) {
      await txn.update({ savings_account_id: target.id }, queryOptions);
      linked += 1;
    }
  }

  return { linked };
}

/**
 * Reassign opening deposits that name this account but are linked to another savings row.
 */
async function reassignMislinkedOpeningTransactions(db, account, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const accountNumber = account.account_number;
  const mislinked = await db.Transaction.findAll({
    where: {
      client_id: account.client_id,
      type: 'deposit',
      [Op.and]: [
        { savings_account_id: { [Op.ne]: null } },
        { savings_account_id: { [Op.ne]: account.id } }
      ],
      description: textLike(db.sequelize, `%${accountNumber}%`)
    },
    ...queryOptions
  });

  let moved = 0;
  for (const txn of mislinked) {
    if (!openingDescriptionMatchesAccount(txn.description, accountNumber)) continue;
    if (normalizeCurrency(txn.currency) !== normalizeCurrency(account.currency)) continue;
    await txn.update({ savings_account_id: account.id }, queryOptions);
    moved += 1;
  }
  return moved;
}

/**
 * Restore soft-deleted deposit/withdrawal rows for this account (incl. opening).
 */
async function restoreSoftDeletedSavingsTransactions(db, account, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const accountNumber = account.account_number;
  const deleted = await db.Transaction.findAll({
    where: {
      client_id: account.client_id,
      type: { [Op.in]: BALANCE_TX_TYPES },
      deletedAt: { [Op.ne]: null },
      [Op.or]: [
        { savings_account_id: account.id },
        {
          savings_account_id: null,
          currency: normalizeCurrency(account.currency),
          [Op.or]: [
            { description: textLike(db.sequelize, `%${accountNumber}%`) },
            { description: textLike(db.sequelize, '%initial deposit%') },
            { purpose: INITIAL_OPENING_PURPOSE }
          ]
        }
      ]
    },
    paranoid: false,
    ...queryOptions
  });

  let restored = 0;
  for (const txn of deleted) {
    if (txn.savings_account_id && txn.savings_account_id !== account.id) continue;
    if (!txn.savings_account_id && !transactionMatchesAccount(txn, account)) continue;
    if (normalizeCurrency(txn.currency) !== normalizeCurrency(account.currency)) continue;
    await txn.restore(queryOptions);
    if (!txn.savings_account_id) {
      await txn.update({ savings_account_id: account.id }, queryOptions);
    }
    restored += 1;
  }
  return restored;
}

async function fetchAttributedTransactions(db, account, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const currency = normalizeCurrency(account.currency);

  const linked = await db.Transaction.findAll({
    where: {
      savings_account_id: account.id,
      type: { [Op.in]: BALANCE_TX_TYPES }
    },
    attributes: ['id', 'type', 'amount', 'status', 'purpose', 'description', 'transaction_date', 'createdAt'],
    order: [
      ['transaction_date', 'ASC'],
      ['createdAt', 'ASC']
    ],
    ...queryOptions
  });

  const orphanCandidates = await db.Transaction.findAll({
    where: {
      client_id: account.client_id,
      savings_account_id: null,
      type: { [Op.in]: BALANCE_TX_TYPES },
      currency
    },
    attributes: ['id', 'type', 'amount', 'status', 'purpose', 'description', 'transaction_date', 'createdAt', 'savings_account_id'],
    ...queryOptions
  });

  const orphansForAccount = orphanCandidates.filter((t) => transactionMatchesAccount(t, account));
  const byId = new Map();
  for (const t of [...linked, ...orphansForAccount]) {
    byId.set(t.id, t);
  }
  return [...byId.values()];
}

function sumFromTransactions(transactions, { includePendingOpening = true } = {}) {
  let net = 0;
  let openingCompleted = 0;
  let openingPending = 0;

  for (const txn of transactions) {
    const amt = parseFloat(txn.amount || 0);
    if (!amt) continue;
    const isOpening = isInitialOpeningDeposit(txn);

    if (txn.status === 'completed') {
      if (txn.type === 'deposit') net += amt;
      if (txn.type === 'withdrawal') net -= amt;
      if (isOpening && txn.type === 'deposit') openingCompleted += amt;
    } else if (txn.status === 'pending' && includePendingOpening && isOpening && txn.type === 'deposit') {
      openingPending += amt;
      net += amt;
    }
  }

  return {
    net: roundMoney(Math.max(0, net)),
    openingCompleted: roundMoney(openingCompleted),
    openingPending: roundMoney(openingPending)
  };
}

/**
 * Infer opening amount when no opening row exists (balance was set at create without txn).
 * Uses the earliest deposit on this account within 90 days of account open.
 */
/**
 * Legacy accounts: opening was set on account.balance at create with no opening txn.
 * Only infer when there is a single early completed deposit (opening-only activity).
 */
function inferBalanceOnlyOpening(transactions, account) {
  const accountCreated = account.createdAt ? new Date(account.createdAt) : null;
  const windowEnd = accountCreated
    ? new Date(accountCreated.getTime() + 14 * 24 * 60 * 60 * 1000)
    : null;

  const deposits = transactions
    .filter((t) => t.type === 'deposit' && t.status === 'completed')
    .filter((t) => {
      if (!accountCreated || !windowEnd) return true;
      const when = new Date(t.transaction_date || t.createdAt);
      return when >= accountCreated && when <= windowEnd;
    })
    .sort((a, b) => {
      const ta = new Date(a.transaction_date || a.createdAt).getTime();
      const tb = new Date(b.transaction_date || b.createdAt).getTime();
      return ta - tb;
    });

  if (deposits.length !== 1) return 0;
  const only = deposits[0];
  if (isInitialOpeningDeposit(only)) return 0;
  return roundMoney(parseFloat(only.amount || 0));
}

/**
 * Compute correct balance: all attributed completed activity + pending opening,
 * plus opening credit missing from the ledger after bad reconciliation.
 */
async function computeRestoredBalanceForAccount(db, account, options = {}) {
  await restoreSoftDeletedOpeningTransactions(db, account, options);
  const transactions = await fetchAttributedTransactions(db, account, options);
  const { net, openingCompleted, openingPending } = sumFromTransactions(transactions);

  const hasOpeningRow = transactions.some((t) => isInitialOpeningDeposit(t));
  let target = net;

  if (!hasOpeningRow) {
    const inferredOpening = inferBalanceOnlyOpening(transactions, account);
    if (inferredOpening > 0 && net < inferredOpening + 0.01) {
      // Opening lived only on account.balance at create; ledger missed it entirely.
      target = roundMoney(Math.max(net, inferredOpening));
    }
  }

  // Floor: never below total opening amounts recorded (completed + pending).
  const openingFloor = roundMoney(openingCompleted + openingPending);
  if (openingFloor > 0) {
    target = Math.max(target, openingFloor);
  }

  return {
    target,
    transaction_count: transactions.length,
    opening_completed: openingCompleted,
    opening_pending: openingPending,
    has_opening_row: hasOpeningRow,
    attributed_net: net
  };
}

/**
 * Restore savings balances after transaction-only reconciliation removed opening credits.
 */
async function restoreInitialDepositsToSavingsBalances(db, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const relinkResult = await relinkOrphanSavingsTransactions(db, options);

  const accounts = await db.SavingsAccount.findAll({
    attributes: ['id', 'client_id', 'account_number', 'balance', 'currency', 'createdAt'],
    order: [['id', 'ASC']],
    ...queryOptions
  });

  const restored = [];
  let restoredCount = 0;
  let unchanged = 0;
  let noActivity = 0;

  for (const account of accounts) {
    const currentBalance = roundMoney(account.balance);
    const analysis = await computeRestoredBalanceForAccount(db, account, options);
    const target = analysis.target;

    if (analysis.transaction_count === 0 && target <= 0) {
      noActivity += 1;
      continue;
    }

    if (target > currentBalance + 0.01) {
      await account.update({ balance: target }, queryOptions);
      restoredCount += 1;
      restored.push({
        savings_account_id: account.id,
        account_number: account.account_number,
        currency: account.currency,
        previous_balance: currentBalance,
        restored_balance: target,
        opening_completed: analysis.opening_completed,
        opening_pending: analysis.opening_pending,
        attributed_net: analysis.attributed_net
      });
    } else {
      unchanged += 1;
    }
  }

  return {
    checked: accounts.length,
    restored: restoredCount,
    unchanged,
    no_activity: noActivity,
    orphans_relinked: relinkResult.linked,
    restored_accounts: restored
  };
}

/**
 * Inspect one account (for support / debugging).
 */
async function inspectSavingsAccountRestore(db, accountNumber) {
  const account = await db.SavingsAccount.findOne({
    where: { account_number: accountNumber },
    attributes: ['id', 'client_id', 'account_number', 'balance', 'currency', 'createdAt']
  });
  if (!account) {
    return { found: false, account_number: accountNumber };
  }

  const currentBalance = roundMoney(account.balance);
  const analysis = await computeRestoredBalanceForAccount(db, account);
  const transactions = await fetchAttributedTransactions(db, account);

  return {
    found: true,
    account_number: account.account_number,
    savings_account_id: account.id,
    currency: account.currency,
    current_balance: currentBalance,
    computed_target_balance: analysis.target,
    would_restore: analysis.target > currentBalance + 0.01,
    analysis,
    transactions: transactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: parseFloat(t.amount || 0),
      status: t.status,
      purpose: t.purpose,
      description: t.description,
      is_opening: isInitialOpeningDeposit(t)
    }))
  };
}

module.exports = {
  BALANCE_TX_TYPES,
  INITIAL_OPENING_PURPOSE,
  isInitialOpeningDeposit,
  applySavingsBalanceChange,
  restoreInitialDepositsToSavingsBalances,
  relinkOrphanSavingsTransactions,
  computeRestoredBalanceForAccount,
  inspectSavingsAccountRestore
};
