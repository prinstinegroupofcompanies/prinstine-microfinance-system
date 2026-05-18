const db = require('../config/database');

/**
 * Ensures PostgreSQL loan status ENUM includes 'overdue' (required for overdue sync + filters).
 */
async function addOverdueLoanStatus() {
  try {
    const sequelize = db.sequelize;
    const dialect = sequelize.options.dialect;

    if (dialect !== 'postgres') {
      console.log('✅ Non-PostgreSQL dialect — overdue status migration skipped.');
      return;
    }

    console.log('🔄 Ensuring "overdue" exists on loans status ENUM...');

    const [enumResults] = await sequelize.query(`
      SELECT DISTINCT t.typname
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_attribute a ON a.atttypid = t.oid
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'loans'
        AND a.attname = 'status'
      LIMIT 1;
    `);

    let enumName = enumResults?.[0]?.typname;
    if (!enumName) {
      const candidates = ['enum_loans_status', 'loans_status_enum'];
      for (const name of candidates) {
        const [check] = await sequelize.query(`SELECT 1 FROM pg_type WHERE typname = '${name}';`);
        if (check?.length) {
          enumName = name;
          break;
        }
      }
    }

    if (!enumName) {
      console.log('⚠️  Could not resolve loans.status enum name — skipping.');
      return;
    }

    const [existing] = await sequelize.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = '${enumName}' AND e.enumlabel = 'overdue';
    `);

    if (existing?.length) {
      console.log('✅ "overdue" already exists on loans status enum.');
      return;
    }

    await sequelize.query(`ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS 'overdue';`);
    console.log(`✅ "overdue" added to ${enumName}.`);
  } catch (error) {
    console.error('⚠️  addOverdueLoanStatus:', error.message);
  }
}

module.exports = addOverdueLoanStatus;
