/**
 * Inspect restore logic for specific savings accounts.
 * Usage: node backend/scripts/inspect-savings-account.js SAV00000149 SAV00000145
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../config/database');
const { inspectSavingsAccountRestore } = require('../helpers/savingsBalance');

async function main() {
  const numbers = process.argv.slice(2);
  if (!numbers.length) {
    console.error('Usage: node backend/scripts/inspect-savings-account.js SAV00000149 ...');
    process.exit(1);
  }

  try {
    await db.sequelize.authenticate();
    for (const num of numbers) {
      const report = await inspectSavingsAccountRestore(db, num);
      console.log(JSON.stringify(report, null, 2));
      console.log('---');
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
