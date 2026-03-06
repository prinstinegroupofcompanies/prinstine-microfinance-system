const db = require('../config/database');

/** Revenue source types for the new model */
const REVENUE_SOURCES = {
  MICROFINANCE_INTEREST: 'microfinance_interest', // 100% of interest from loans to clients without savings
  DUES: 'dues',                                   // 45% of dues paid by clients with savings
  GENERAL_INTEREST: 'general_interest',           // 30% of interest from loans to clients with savings
  PENALTY: 'penalty'                              // 50% of fines/penalties paid
};

/**
 * Generate a unique revenue_number (REV-YYYYMMDD-XXXXX)
 */
async function generateRevenueNumber() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let attempts = 0;
  while (attempts < 100) {
    const suffix = String(Date.now()).slice(-5) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const revenueNumber = `REV-${datePart}-${suffix}`;
    const exists = await db.Revenue.findOne({
      where: { revenue_number: revenueNumber },
      paranoid: false
    });
    if (!exists) return revenueNumber;
    attempts++;
  }
  return `REV-${datePart}-${Date.now()}`;
}

/**
 * Create a Revenue record for the company.
 * @param {Object} params
 * @param {string} params.source - One of REVENUE_SOURCES
 * @param {number} params.amount - Revenue amount
 * @param {string} [params.currency='USD'] - LRD or USD
 * @param {number} [params.transaction_id] - Related transaction id
 * @param {number} [params.loan_id] - Related loan id
 * @param {string} [params.description] - Optional description
 * @param {Date} [params.revenue_date] - Defaults to now
 * @param {number} [params.created_by] - User id
 * @returns {Promise<Model|null>} Created Revenue or null on failure
 */
async function createRevenue({ source, amount, currency = 'USD', transaction_id, loan_id, description, revenue_date, created_by }) {
  if (!amount || amount <= 0) return null;
  const safeAmount = parseFloat(amount);
  if (!Number.isFinite(safeAmount)) return null;
  try {
    const revenueNumber = await generateRevenueNumber();
    const revenue = await db.Revenue.create({
      revenue_number: revenueNumber,
      source,
      amount: safeAmount,
      currency: currency === 'LRD' ? 'LRD' : 'USD',
      transaction_id: transaction_id || null,
      loan_id: loan_id || null,
      description: description || null,
      revenue_date: revenue_date || new Date(),
      created_by: created_by || null
    });
    return revenue;
  } catch (err) {
    console.error('createRevenue error:', err);
    return null;
  }
}

/**
 * Check if a client has savings (at least one active savings account with balance > 0 or any account).
 * Used to distinguish microfinance (no savings) vs general (with savings) loans.
 */
async function clientHasSavings(clientId) {
  if (!clientId) return false;
  const accounts = await db.SavingsAccount.findAll({
    where: { client_id: clientId },
    attributes: ['id', 'balance', 'status'],
    paranoid: true
  });
  return accounts.some(a => parseFloat(a.balance || 0) > 0 && (a.status === 'active' || !a.status));
}

module.exports = {
  REVENUE_SOURCES,
  createRevenue,
  clientHasSavings
};
