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
  const d = txn.description;
  return typeof d === 'string' && d.startsWith('Initial deposit for ');
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

/**
 * One-time restore after transaction-only reconciliation removed opening credits.
 * Sets balance to: opening deposit(s) + other completed deposits − completed withdrawals,
 * only when that target is higher than the current stored balance.
 */
async function restoreInitialDepositsToSavingsBalances(db, options = {}) {
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const accounts = await db.SavingsAccount.findAll({
    attributes: ['id', 'client_id', 'account_number', 'balance', 'currency'],
    ...queryOptions
  });

  const restored = [];
  let restoredCount = 0;

  for (const account of accounts) {
    const openingTxns = await db.Transaction.findAll({
      where: {
        type: 'deposit',
        [Op.and]: [
          {
            [Op.or]: [
              { purpose: INITIAL_OPENING_PURPOSE },
              { description: { [Op.like]: 'Initial deposit for %' } }
            ]
          },
          {
            [Op.or]: [
              { savings_account_id: account.id },
              {
                client_id: account.client_id,
                savings_account_id: null,
                description: { [Op.like]: `Initial deposit for ${account.account_number}%` }
              }
            ]
          }
        ]
      },
      attributes: ['id', 'amount', 'status', 'purpose', 'description', 'savings_account_id'],
      ...queryOptions
    });

    for (const txn of openingTxns) {
      if (!txn.savings_account_id) {
        await txn.update({ savings_account_id: account.id }, queryOptions);
      }
    }

    const openingTotal = roundMoney(
      openingTxns.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
    );
    if (openingTotal <= 0) continue;

    const completedOpening = roundMoney(
      openingTxns
        .filter((t) => t.status === 'completed')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
    );

    const completedTxns = await db.Transaction.findAll({
      where: {
        savings_account_id: account.id,
        type: { [Op.in]: BALANCE_TX_TYPES },
        status: 'completed'
      },
      attributes: ['type', 'amount'],
      ...queryOptions
    });

    let completedNet = 0;
    for (const txn of completedTxns) {
      const amt = parseFloat(txn.amount || 0);
      if (txn.type === 'deposit') completedNet += amt;
      if (txn.type === 'withdrawal') completedNet -= amt;
    }
    completedNet = roundMoney(completedNet);

    const targetBalance = Math.max(0, roundMoney(openingTotal + completedNet - completedOpening));
    const currentBalance = roundMoney(account.balance);

    if (targetBalance > currentBalance + 0.01) {
      await account.update({ balance: targetBalance }, queryOptions);
      restoredCount += 1;
      restored.push({
        savings_account_id: account.id,
        account_number: account.account_number,
        currency: account.currency,
        previous_balance: currentBalance,
        restored_balance: targetBalance,
        opening_deposit: openingTotal
      });
    }
  }

  return {
    checked: accounts.length,
    restored: restoredCount,
    restored_accounts: restored
  };
}

module.exports = {
  BALANCE_TX_TYPES,
  INITIAL_OPENING_PURPOSE,
  isInitialOpeningDeposit,
  applySavingsBalanceChange,
  restoreInitialDepositsToSavingsBalances
};
