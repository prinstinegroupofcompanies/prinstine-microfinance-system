const { Op } = require('sequelize');

const BALANCE_TX_TYPES = ['deposit', 'withdrawal'];

/** Matches savings account creation (`backend/routes/savings.js`). */
const INITIAL_OPENING_PURPOSE = 'Initial account opening deposit';

function roundMoney(value) {
  return Math.round((parseFloat(value || 0) + Number.EPSILON) * 100) / 100;
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

function textLike(sequelize, value) {
  const dialect = sequelize?.getDialect?.() || 'postgres';
  return dialect === 'postgres' ? { [Op.iLike]: value } : { [Op.like]: value };
}

async function findOpeningDepositTransactions(db, account, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const accountNumber = account.account_number;
  const accountCreated = account.createdAt ? new Date(account.createdAt) : null;
  const windowStart = accountCreated
    ? new Date(accountCreated.getTime() - 7 * 24 * 60 * 60 * 1000)
    : null;
  const windowEnd = accountCreated
    ? new Date(accountCreated.getTime() + 30 * 24 * 60 * 60 * 1000)
    : null;

  const linked = await db.Transaction.findAll({
    where: {
      savings_account_id: account.id,
      type: 'deposit',
      [Op.or]: [
        { purpose: INITIAL_OPENING_PURPOSE },
        { purpose: textLike(db.sequelize, '%initial%opening%') },
        { purpose: textLike(db.sequelize, '%initial%deposit%') },
        { description: textLike(db.sequelize, 'Initial deposit for %') },
        { description: textLike(db.sequelize, '%initial deposit%') }
      ]
    },
    attributes: ['id', 'amount', 'status', 'purpose', 'description', 'savings_account_id', 'createdAt'],
    ...queryOptions
  });

  const orphanWhere = {
    client_id: account.client_id,
    type: 'deposit',
    savings_account_id: null,
    [Op.or]: [
      { purpose: INITIAL_OPENING_PURPOSE },
      { purpose: textLike(db.sequelize, '%initial%opening%') },
      { purpose: textLike(db.sequelize, '%initial%deposit%') },
      { description: textLike(db.sequelize, 'Initial deposit for %') },
      { description: textLike(db.sequelize, `%${accountNumber}%`) }
    ]
  };

  if (windowStart && windowEnd) {
    orphanWhere.createdAt = { [Op.between]: [windowStart, windowEnd] };
  }

  const orphans = await db.Transaction.findAll({
    where: orphanWhere,
    attributes: ['id', 'amount', 'status', 'purpose', 'description', 'savings_account_id', 'createdAt'],
    ...queryOptions
  });

  const byId = new Map();
  for (const txn of [...linked, ...orphans]) {
    if (isInitialOpeningDeposit(txn) || openingDescriptionMatchesAccount(txn.description, accountNumber)) {
      byId.set(txn.id, txn);
    }
  }

  let openingTxns = [...byId.values()];

  if (openingTxns.length === 0) {
    const firstDeposit = await db.Transaction.findOne({
      where: {
        type: 'deposit',
        status: 'completed',
        [Op.or]: [
          { savings_account_id: account.id },
          {
            client_id: account.client_id,
            savings_account_id: null,
            ...(windowStart && windowEnd
              ? { createdAt: { [Op.between]: [windowStart, windowEnd] } }
              : {})
          }
        ]
      },
      order: [
        ['transaction_date', 'ASC'],
        ['createdAt', 'ASC']
      ],
      attributes: ['id', 'amount', 'status', 'purpose', 'description', 'savings_account_id', 'createdAt'],
      ...queryOptions
    });
    if (firstDeposit) {
      openingTxns = [firstDeposit];
    }
  }

  return openingTxns;
}

async function sumCompletedNet(db, savingsAccountId, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const completedTxns = await db.Transaction.findAll({
    where: {
      savings_account_id: savingsAccountId,
      type: { [Op.in]: BALANCE_TX_TYPES },
      status: 'completed'
    },
    attributes: ['type', 'amount'],
    ...queryOptions
  });

  let net = 0;
  for (const txn of completedTxns) {
    const amt = parseFloat(txn.amount || 0);
    if (txn.type === 'deposit') net += amt;
    if (txn.type === 'withdrawal') net -= amt;
  }
  return roundMoney(net);
}

/**
 * Restore opening deposits removed by transaction-only reconciliation.
 * Credits initial/opening deposits plus other completed activity when balance is too low.
 */
async function restoreInitialDepositsToSavingsBalances(db, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const accounts = await db.SavingsAccount.findAll({
    attributes: ['id', 'client_id', 'account_number', 'balance', 'currency', 'createdAt'],
    ...queryOptions
  });

  const restored = [];
  let restoredCount = 0;
  let skippedNoOpening = 0;

  for (const account of accounts) {
    const accountCreated = account.createdAt ? new Date(account.createdAt) : null;
    const openingTxns = await findOpeningDepositTransactions(db, account, options);

    for (const txn of openingTxns) {
      if (!txn.savings_account_id) {
        await txn.update({ savings_account_id: account.id }, queryOptions);
      }
    }

    const openingTotal = roundMoney(
      openingTxns.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
    );
    if (openingTotal <= 0) {
      skippedNoOpening += 1;
      continue;
    }

    const completedOpening = roundMoney(
      openingTxns
        .filter((t) => t.status === 'completed')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
    );

    const completedNet = await sumCompletedNet(db, account.id, options);
    const currentBalance = roundMoney(account.balance);

    // Opening counted once + all other completed deposit/withdrawal activity
    const targetBalance = Math.max(0, roundMoney(openingTotal + completedNet - completedOpening));

    // Also fix accounts where balance is below the opening amount alone (reconcile zeroed opening)
    const minimumWithOpening = Math.max(targetBalance, openingTotal);

    let finalBalance = minimumWithOpening;

    // Link other orphan client deposits from the opening period, then re-check balance
    if (accountCreated) {
      const windowStart = new Date(accountCreated.getTime() - 7 * 24 * 60 * 60 * 1000);
      const windowEnd = new Date(accountCreated.getTime() + 30 * 24 * 60 * 60 * 1000);
      const orphanDeposits = await db.Transaction.findAll({
        where: {
          client_id: account.client_id,
          type: 'deposit',
          status: 'completed',
          savings_account_id: null,
          createdAt: { [Op.between]: [windowStart, windowEnd] }
        },
        attributes: ['id'],
        ...queryOptions
      });
      for (const txn of orphanDeposits) {
        await txn.update({ savings_account_id: account.id }, queryOptions);
      }
      if (orphanDeposits.length > 0) {
        const netAfterLink = await sumCompletedNet(db, account.id, options);
        finalBalance = Math.max(finalBalance, netAfterLink);
      }
    }

    if (finalBalance > currentBalance + 0.01) {
      await account.update({ balance: finalBalance }, queryOptions);
      restoredCount += 1;
      restored.push({
        savings_account_id: account.id,
        account_number: account.account_number,
        currency: account.currency,
        previous_balance: currentBalance,
        restored_balance: finalBalance,
        opening_deposit: openingTotal,
        completed_net: completedNet
      });
    }
  }

  return {
    checked: accounts.length,
    restored: restoredCount,
    skipped_no_opening_txn: skippedNoOpening,
    restored_accounts: restored
  };
}

module.exports = {
  BALANCE_TX_TYPES,
  INITIAL_OPENING_PURPOSE,
  isInitialOpeningDeposit,
  applySavingsBalanceChange,
  restoreInitialDepositsToSavingsBalances,
  findOpeningDepositTransactions
};
