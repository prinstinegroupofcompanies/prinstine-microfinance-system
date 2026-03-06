const express = require('express');
const { Op } = require('sequelize');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getBorrowerClient } = require('../helpers/borrower');
const { createRevenue, REVENUE_SOURCES } = require('../helpers/revenue');

const router = express.Router();

router.use(authenticate);

const APPROVER_ROLES = ['admin', 'head_micro_loan', 'supervisor'];

// Get all transactions
router.get('/', async (req, res) => {
  try {
    const userRole = req.user?.role || 'user';
    
    // For borrower role, get their client_id (by user_id or email fallback)
    let clientId = null;
    let whereClause = {};
    if (userRole === 'borrower') {
      const client = await getBorrowerClient(req.userId, req.user?.email);
      if (client) {
        clientId = client.id;
        whereClause.client_id = clientId;
      }
    } else if (req.query.client_id) {
      const queryClientId = parseInt(req.query.client_id);
      if (!isNaN(queryClientId)) {
        whereClause.client_id = queryClientId;
      }
    }

    if (req.query.status) {
      whereClause.status = req.query.status;
    }
    if (req.query.type) {
      const typeVal = req.query.type;
      const types = Array.isArray(typeVal) ? typeVal : (typeof typeVal === 'string' ? typeVal.split(',') : [typeVal]);
      whereClause.type = types.length === 1 ? types[0] : { [Op.in]: types };
    }

    // Get limit from query params, default to 100
    const limit = parseInt(req.query.limit) || 100;
    
    let transactions = [];
    try {
      transactions = await db.Transaction.findAll({
        where: whereClause,
        include: [
          { model: db.Client, as: 'client', required: false },
          { model: db.Loan, as: 'loan', required: false },
          { model: db.Branch, as: 'branch', required: false }
        ],
        order: [['createdAt', 'DESC']],
        limit: limit
      });
    } catch (includeError) {
      console.error('Transaction include error:', includeError);
      // Fallback without includes if associations are misconfigured
      transactions = await db.Transaction.findAll({
        where: whereClause,
        order: [['createdAt', 'DESC']],
        limit: limit
      });
    }

    res.json({
      success: true,
      data: { transactions }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Create transaction
router.post('/', [
  body('client_id').isInt().withMessage('Client ID is required'),
  body('type').isIn(['deposit', 'withdrawal', 'loan_payment', 'loan_disbursement', 'fee', 'interest', 'penalty', 'transfer', 'push_back', 'personal_interest_payment', 'general_interest', 'due_payment']).withMessage('Valid transaction type is required'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Valid amount is required'),
  body('currency').optional().isIn(['LRD', 'USD']).withMessage('Currency must be LRD or USD'),
  body('purpose').notEmpty().withMessage('Purpose of transaction is required'),
  body('description').optional().isString(),
  body('loan_id').optional().isInt(),
  body('savings_account_id').optional().isInt(),
  body('transaction_date').optional().isISO8601().toDate()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      console.error('Request body:', req.body);
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    // Validate client exists
    const client = await db.Client.findByPk(req.body.client_id);
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Validate loan if provided
    if (req.body.loan_id) {
      const loan = await db.Loan.findByPk(req.body.loan_id);
      if (!loan) {
        return res.status(404).json({ success: false, message: 'Loan not found' });
      }
    }

    // Validate savings account if provided
    if (req.body.savings_account_id) {
      const savings = await db.SavingsAccount.findByPk(req.body.savings_account_id);
      if (!savings) {
        return res.status(404).json({ success: false, message: 'Savings account not found' });
      }
    }

    // Generate unique transaction number (avoid count-based collisions)
    let transactionNumber;
    try {
      const lastTransaction = await db.Transaction.findOne({
        attributes: ['transaction_number'],
        order: [['id', 'DESC']],
        paranoid: false
      });
      let sequenceNumber = 1;
      if (lastTransaction?.transaction_number) {
        const lastNumber = parseInt(String(lastTransaction.transaction_number).replace('TXN', '')) || 0;
        sequenceNumber = lastNumber + 1;
      }
      let attempts = 0;
      do {
        transactionNumber = `TXN${String(sequenceNumber).padStart(8, '0')}`;
        const existing = await db.Transaction.findOne({
          where: { transaction_number: transactionNumber },
          paranoid: false
        });
        if (!existing) break;
        sequenceNumber++;
        attempts++;
      } while (attempts < 100);
      if (!transactionNumber) {
        transactionNumber = `TXN${String(Date.now()).slice(-8)}`;
      }
    } catch (error) {
      console.error('Transaction number generation error:', error);
      transactionNumber = `TXN${String(Date.now()).slice(-8)}`;
    }

    // Determine currency for transaction
    let currency = req.body.currency || 'USD';
    
    // If transaction is related to a loan, inherit currency from loan
    if (req.body.loan_id && !req.body.currency) {
      const loan = await db.Loan.findByPk(req.body.loan_id);
      if (loan && loan.currency) {
        currency = loan.currency;
      }
    }
    
    // If transaction is related to a savings account, inherit currency from savings
    if (req.body.savings_account_id && !req.body.currency) {
      const savings = await db.SavingsAccount.findByPk(req.body.savings_account_id);
      if (savings && savings.currency) {
        currency = savings.currency;
      }
    }
    
    // If due payment, validate and inherit currency from client's dues_currency
    if (req.body.type === 'due_payment') {
      const currentDues = parseFloat(client.total_dues || 0);
      if (client.dues_currency) {
        // If currency provided, validate it matches client's dues currency
        if (req.body.currency && req.body.currency !== client.dues_currency) {
          // Allow switching currency only when no outstanding dues exist yet
          if (currentDues === 0) {
            currency = req.body.currency;
          } else {
            return res.status(400).json({ 
              success: false, 
              message: `Due payment currency must match client's dues currency (${client.dues_currency})` 
            });
          }
        }
        // If no currency provided, use client's dues currency
        if (!req.body.currency) {
          currency = client.dues_currency;
        }
      }
    }
    
    // Validate currency
    if (!['LRD', 'USD'].includes(currency)) {
      currency = 'USD'; // Default to USD if invalid
    }

    // Prepare transaction data
    const transactionData = {
      transaction_number: transactionNumber,
      client_id: parseInt(req.body.client_id),
      loan_id: req.body.loan_id ? parseInt(req.body.loan_id) : null,
      savings_account_id: req.body.savings_account_id ? parseInt(req.body.savings_account_id) : null,
      type: req.body.type,
      amount: parseFloat(req.body.amount),
      currency: currency,
      description: req.body.description || null,
      purpose: req.body.purpose || null, // Include purpose field
      branch_id: req.body.branch_id ? parseInt(req.body.branch_id) : (req.user?.branch_id || null),
      status: 'completed',
      transaction_date: req.body.transaction_date ? new Date(req.body.transaction_date) : new Date(),
      created_by: req.userId
    };

    let transaction;
    try {
      transaction = await db.Transaction.create(transactionData);
    } catch (createError) {
      if (createError.name === 'SequelizeUniqueConstraintError' && createError.fields?.transaction_number) {
        // Retry once with a fresh transaction number
        transactionNumber = `TXN${String(Date.now()).slice(-8)}`;
        transactionData.transaction_number = transactionNumber;
        transaction = await db.Transaction.create(transactionData);
      } else {
        throw createError;
      }
    }

    // Handle due payment - add or reduce client's total_dues (only if same currency)
    if (req.body.type === 'due_payment' && client) {
      const paymentAmount = parseFloat(req.body.amount || 0);
      const currentDues = parseFloat(client.total_dues || 0);
      let updatedCurrency = client.dues_currency || currency;

      // Allow updating dues currency when there are no outstanding dues yet
      if (currentDues === 0 && req.body.currency) {
        updatedCurrency = req.body.currency;
      }

      // If client has no dues currency yet or we're switching with zero dues, set it from transaction
      if ((!client.dues_currency || currentDues === 0) && updatedCurrency) {
        await client.update({ dues_currency: updatedCurrency });
      }

      // Currency should already match at this point (validated above)
      if (updatedCurrency === currency) {
        let newDues = 0;
        if (currentDues >= 0) {
          // No outstanding dues yet - treat this as adding dues
          newDues = -Math.abs(paymentAmount);
        } else {
          // Reduce outstanding dues (stored as negative)
          newDues = Math.min(0, currentDues + paymentAmount);
        }
        await client.update({ total_dues: newDues });
      } else {
        console.warn(`Due payment currency (${currency}) does not match client dues currency (${updatedCurrency})`);
      }
    }

    // New revenue model: create Revenue records for company share
    try {
      const amount = parseFloat(transaction.amount || 0);
      const txnDate = transaction.transaction_date || new Date();
      if (req.body.type === 'due_payment' && amount > 0) {
        const companyShare = amount * 0.45;
        await createRevenue({
          source: REVENUE_SOURCES.DUES,
          amount: companyShare,
          currency,
          transaction_id: transaction.id,
          description: `Dues revenue (45%) from client ${transaction.client_id}`,
          revenue_date: txnDate,
          created_by: req.userId
        });
      } else if (req.body.type === 'general_interest' && amount > 0) {
        const companyShare = amount * 0.30;
        await createRevenue({
          source: REVENUE_SOURCES.GENERAL_INTEREST,
          amount: companyShare,
          currency,
          transaction_id: transaction.id,
          loan_id: transaction.loan_id || null,
          description: `General interest revenue (30%) from loan interest`,
          revenue_date: txnDate,
          created_by: req.userId
        });
      } else if (req.body.type === 'penalty' && amount > 0) {
        const companyShare = amount * 0.50;
        await createRevenue({
          source: REVENUE_SOURCES.PENALTY,
          amount: companyShare,
          currency,
          transaction_id: transaction.id,
          description: `Penalty/fine revenue (50%) from client`,
          revenue_date: txnDate,
          created_by: req.userId
        });
      }
    } catch (revenueErr) {
      console.error('Revenue creation on transaction error:', revenueErr);
    }

    // When a loan_payment transaction is created via Transactions UI, apply it to the loan so repayments take effect
    if (req.body.type === 'loan_payment' && transaction.loan_id) {
      try {
        const loan = await db.Loan.findByPk(transaction.loan_id, {
          include: [{ model: db.Client, as: 'client', required: false }]
        });
        if (loan && (loan.status === 'active' || loan.status === 'disbursed' || loan.status === 'overdue')) {
          const paymentAmount = parseFloat(transaction.amount || 0);
          const outstanding = parseFloat(loan.outstanding_balance ?? loan.total_amount ?? loan.amount ?? 0);
          if (paymentAmount > 0 && paymentAmount <= outstanding) {
            const nextRep = await db.LoanRepayment.findOne({
              where: { loan_id: loan.id, status: { [Op.in]: ['pending', 'partial'] } },
              order: [['due_date', 'ASC'], ['installment_number', 'ASC']]
            });
            let interestAmt = 0;
            let principalAmt = paymentAmount;
            if (nextRep) {
              interestAmt = Math.min(paymentAmount, parseFloat(nextRep.interest_amount || 0));
              principalAmt = paymentAmount - interestAmt;
              const rem = parseFloat(nextRep.amount || 0) - paymentAmount;
              await nextRep.update({
                amount: paymentAmount,
                principal_amount: principalAmt,
                interest_amount: interestAmt,
                payment_date: transaction.transaction_date ? new Date(transaction.transaction_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
                status: rem <= 0.01 ? 'completed' : 'partial',
                transaction_id: transaction.id
              });
            } else {
              const adHocNum = `${loan.loan_number}-ADHOC-${String(Date.now()).slice(-6)}`;
              await db.LoanRepayment.create({
                loan_id: loan.id,
                repayment_number: adHocNum,
                installment_number: 0,
                amount: paymentAmount,
                principal_amount: principalAmt,
                interest_amount: 0,
                payment_date: transaction.transaction_date ? new Date(transaction.transaction_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
                status: 'completed',
                transaction_id: transaction.id,
                due_date: transaction.transaction_date ? new Date(transaction.transaction_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
                created_by: req.userId
              });
            }
            const newOut = Math.max(0, outstanding - principalAmt);
            const newPaid = parseFloat(loan.total_paid || 0) + paymentAmount;
            await loan.update({
              outstanding_balance: newOut,
              total_paid: newPaid,
              status: newOut <= 0.01 ? 'completed' : loan.status
            });
            // Optional: interest distribution for client/general (same as in repay route) - skip for brevity when created via Transactions UI
          }
        }
      } catch (loanPayErr) {
        console.error('Apply loan_payment to loan error:', loanPayErr);
      }
    }

    // Reload transaction with associations for response
    let createdTransaction = null;
    try {
      createdTransaction = await db.Transaction.findByPk(transaction.id, {
        include: [
          { model: db.Client, as: 'client', required: false },
          { model: db.Loan, as: 'loan', required: false },
          { model: db.SavingsAccount, as: 'savingsAccount', required: false }
        ]
      });
    } catch (includeError) {
      console.error('Transaction reload include error:', includeError);
      createdTransaction = await db.Transaction.findByPk(transaction.id);
    }

    res.status(201).json({
      success: true,
      message: 'Transaction created successfully',
      data: { 
        transaction: createdTransaction,
        receipt: {
          transaction_number: transactionNumber,
          client_name: client ? `${client.first_name} ${client.last_name}` : '',
          amount: req.body.amount,
          currency: currency,
          date: transaction.transaction_date,
          type: req.body.type,
          description: req.body.description
        }
      }
    });
  } catch (error) {
    console.error('Create transaction error:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', JSON.stringify(req.body, null, 2));
    res.status(500).json({
      success: false,
      message: 'Failed to create transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get single transaction
router.get('/:id', async (req, res) => {
  try {
    const transaction = await db.Transaction.findByPk(req.params.id, {
      include: [
        { model: db.Client, as: 'client', required: false },
        { model: db.Loan, as: 'loan', required: false },
        { model: db.SavingsAccount, as: 'savingsAccount', required: false },
        { model: db.Branch, as: 'branch', required: false }
      ]
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: { transaction }
    });
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Approve pending transaction (supervisor, head_micro_loan, or admin only)
router.post('/:id/approve', authorize(...APPROVER_ROLES), async (req, res) => {
  try {
    const transaction = await db.Transaction.findByPk(req.params.id, {
      include: [{ model: db.SavingsAccount, as: 'savingsAccount', required: false }]
    });
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }
    if (transaction.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Only pending transactions can be approved'
      });
    }
    if (transaction.type !== 'deposit' && transaction.type !== 'withdrawal') {
      return res.status(400).json({
        success: false,
        message: 'Only deposit or withdrawal transactions can be approved'
      });
    }
    const savingsAccount = transaction.savingsAccount;
    if (!savingsAccount) {
      return res.status(400).json({
        success: false,
        message: 'Transaction has no linked savings account'
      });
    }
    const amount = parseFloat(transaction.amount || 0);
    const currentBalance = parseFloat(savingsAccount.balance || 0);
    const newBalance = transaction.type === 'deposit'
      ? currentBalance + amount
      : Math.max(0, currentBalance - amount);
    if (transaction.type === 'withdrawal' && amount > currentBalance) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance to approve this withdrawal'
      });
    }
    await savingsAccount.update({ balance: newBalance });
    await transaction.update({ status: 'completed' });
    res.json({
      success: true,
      message: 'Transaction approved successfully',
      data: {
        transaction,
        savings_account: { account_number: savingsAccount.account_number, balance: newBalance }
      }
    });
  } catch (error) {
    console.error('Approve transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Update transaction
router.put('/:id', [
  body('amount').optional().isFloat({ min: 0.01 }),
  body('type').optional().isIn(['deposit', 'withdrawal', 'loan_payment', 'loan_disbursement', 'fee', 'interest', 'penalty', 'transfer', 'push_back', 'personal_interest_payment', 'general_interest', 'due_payment']),
  body('currency').optional().isIn(['LRD', 'USD'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const transaction = await db.Transaction.findByPk(req.params.id);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    await transaction.update(req.body);

    res.json({
      success: true,
      message: 'Transaction updated successfully',
      data: { transaction }
    });
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Delete transaction (soft delete) and related revenue
router.delete('/:id', async (req, res) => {
  const dbTransaction = await db.sequelize.transaction();
  try {
    const transaction = await db.Transaction.findByPk(req.params.id, { transaction: dbTransaction });
    if (!transaction) {
      await dbTransaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    await db.Revenue.destroy({
      where: { transaction_id: transaction.id },
      transaction: dbTransaction
    });

    await transaction.destroy({ transaction: dbTransaction });

    await dbTransaction.commit();

    res.json({
      success: true,
      message: 'Transaction deleted successfully'
    });
  } catch (error) {
    await dbTransaction.rollback();
    console.error('Delete transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;

