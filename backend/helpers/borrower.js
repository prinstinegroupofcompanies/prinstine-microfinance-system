const db = require('../config/database');
const { Op } = require('sequelize');

/**
 * Get the Client record for a borrower user.
 * Tries user_id first; if not found, tries matching client by user email and links them.
 * @param {number} userId - req.userId
 * @param {string} [userEmail] - req.user?.email (for fallback lookup)
 * @returns {Promise<import('../models/Client')|null>}
 */
async function getBorrowerClient(userId, userEmail) {
  if (!userId) return null;
  let client = await db.Client.findOne({ where: { user_id: userId } });
  if (client) return client;
  if (!userEmail || typeof userEmail !== 'string') return null;
  const email = userEmail.toLowerCase().trim();
  const { sequelize } = db;
  client = await db.Client.findOne({
    where: sequelize.where(
      sequelize.fn('LOWER', sequelize.col('email')),
      email
    )
  });
  if (client) {
    try {
      await client.update({ user_id: userId });
    } catch (err) {
      console.error('Failed to link client to user:', err);
    }
    return client;
  }
  return null;
}

module.exports = { getBorrowerClient };
