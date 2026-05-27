/**
 * One-off: restore initial opening deposits to savings balances after reconciliation.
 * Usage: node backend/scripts/restore-savings-initial-deposits.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../config/database');
const { restoreInitialDepositsToSavingsBalances } = require('../helpers/savingsBalance');

async function main() {
  try {
    await db.sequelize.authenticate();
    const result = await restoreInitialDepositsToSavingsBalances(db);
    console.log(`Checked ${result.checked} account(s), restored ${result.restored}.`);
    if (result.restored_accounts?.length) {
      result.restored_accounts.slice(0, 20).forEach((row) => {
        console.log(
          `  ${row.account_number}: ${row.previous_balance} → ${row.restored_balance} (opening ${row.opening_deposit})`
        );
      });
      if (result.restored_accounts.length > 20) {
        console.log(`  … and ${result.restored_accounts.length - 20} more`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
