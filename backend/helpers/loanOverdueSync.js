const { Op } = require('sequelize');

/**
 * Aligns loan.status with installment due dates: marks loans overdue when any
 * pending/partial installment is past due; clears overdue when caught up.
 */
async function syncOverdueLoanStatuses(db) {
  const today = new Date().toISOString().split('T')[0];

  const pastDueRows = await db.LoanRepayment.findAll({
    attributes: ['loan_id'],
    where: {
      due_date: { [Op.lt]: today },
      status: { [Op.in]: ['pending', 'partial'] }
    },
    group: ['loan_id'],
    raw: true
  });
  const loanIdsPastDue = [...new Set(pastDueRows.map((r) => r.loan_id).filter(Boolean))];

  if (loanIdsPastDue.length > 0) {
    await db.Loan.update(
      { status: 'overdue' },
      {
        where: {
          id: { [Op.in]: loanIdsPastDue },
          status: { [Op.in]: ['active', 'disbursed'] },
          outstanding_balance: { [Op.gt]: 0 }
        }
      }
    );
  }

  const clearWhere = {
    status: 'overdue',
    outstanding_balance: { [Op.gt]: 0 }
  };
  if (loanIdsPastDue.length > 0) {
    clearWhere.id = { [Op.notIn]: loanIdsPastDue };
  }

  await db.Loan.update({ status: 'active' }, { where: clearWhere });
}

module.exports = { syncOverdueLoanStatuses };
