const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { Op } = require('sequelize');
const { getBorrowerClient } = require('../helpers/borrower');
const { createRevenue, clientHasSavings, REVENUE_SOURCES } = require('../helpers/revenue');

const router = express.Router();
const { LOAN_TYPES, getLoanTypeConfig } = require('../config/loanTypes');
const { syncOverdueLoanStatuses } = require('../helpers/loanOverdueSync');

// Get loan type configurations
router.get('/types', authenticate, (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        loan_types: LOAN_TYPES
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loan types',
      error: error.message
    });
  }
});

// Get all loans
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 10, search, status, loan_type } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const offset = (pageNum - 1) * limitNum;
    const branchId = req.user?.branch_id || null;
    const userRole = req.user?.role || 'user';

    if (userRole !== 'borrower') {
      await syncOverdueLoanStatuses(db);
    }

    // For borrower role, get their client_id (by user_id or email fallback)
    let clientId = null;
    if (userRole === 'borrower') {
      const client = await getBorrowerClient(req.userId, req.user?.email);
      if (client) {
        clientId = client.id;
      }
    }

    let whereClause = {};
    if (userRole === 'borrower' && clientId) {
      // For borrowers, only show their own loans
      whereClause.client_id = clientId;
    } else if (branchId && userRole !== 'admin' && userRole !== 'general_manager') {
      whereClause.branch_id = branchId;
    }

    if (search) {
      whereClause[Op.or] = [{ loan_number: { [Op.like]: `%${search}%` } }];
    }

    if (status) whereClause.status = status;
    if (loan_type) whereClause.loan_type = loan_type;

    const { count, rows } = await db.Loan.findAndCountAll({
      where: whereClause,
      distinct: true,
      col: 'Loan.id',
      include: [
        { model: db.Client, as: 'client', required: false, attributes: ['id', 'first_name', 'last_name', 'client_number'] },
        { model: db.Branch, as: 'branch', required: false, attributes: ['id', 'name'] },
        { model: db.Collateral, as: 'collateral', required: false }
      ],
      limit: limitNum,
      offset,
      order: [['createdAt', 'DESC']]
    });

    const today = new Date().toISOString().split('T')[0];
    const overdueLoanIds = rows.filter((l) => l.status === 'overdue').map((l) => l.id);
    let daysOverdueByLoanId = {};
    if (overdueLoanIds.length > 0) {
      const reps = await db.LoanRepayment.findAll({
        where: {
          loan_id: { [Op.in]: overdueLoanIds },
          due_date: { [Op.lt]: today },
          status: { [Op.in]: ['pending', 'partial'] }
        },
        attributes: ['loan_id', 'due_date'],
        raw: true
      });
      const t0 = new Date(`${today}T12:00:00`);
      for (const r of reps) {
        const d0 = new Date(String(r.due_date).substring(0, 10) + 'T12:00:00');
        const days = Math.floor((t0 - d0) / 86400000);
        const lid = r.loan_id;
        daysOverdueByLoanId[lid] = Math.max(daysOverdueByLoanId[lid] || 0, days);
      }
    }

    const loansPayload = rows.map((loan) => {
      const j = typeof loan.toJSON === 'function' ? loan.toJSON() : loan;
      if (j.status === 'overdue' && daysOverdueByLoanId[j.id] != null) {
        j.days_overdue = daysOverdueByLoanId[j.id];
      }
      return j;
    });

    res.json({
      success: true,
      data: {
        loans: loansPayload,
        pagination: {
          total: count,
          page: pageNum,
          limit: limitNum,
          pages: Math.max(1, Math.ceil(count / limitNum))
        }
      }
    });
  } catch (error) {
    console.error('Get loans error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loans',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get single loan
router.get('/:id', authenticate, async (req, res) => {
  try {
    const loan = await db.Loan.findByPk(req.params.id, {
      include: [
        { model: db.Client, as: 'client', required: false, attributes: ['id', 'first_name', 'last_name', 'client_number', 'email', 'phone'] },
        { model: db.Branch, as: 'branch', required: false, attributes: ['id', 'name', 'code'] },
        { model: db.Collateral, as: 'collateral', required: false, attributes: ['id', 'type', 'description', 'estimated_value', 'currency', 'status'] },
        { 
          model: db.LoanRepayment, 
          as: 'repayments', 
          required: false,
          attributes: ['id', 'repayment_number', 'installment_number', 'amount', 'principal_amount', 'interest_amount', 'penalty_amount', 'due_date', 'payment_date', 'status', 'payment_method'],
          separate: true, // Fetch repayments in a separate query to allow proper ordering
          order: [['installment_number', 'ASC']]
        }
      ]
    });

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    // Borrower can only view their own loan
    if (req.user?.role === 'borrower') {
      const client = await getBorrowerClient(req.userId, req.user?.email);
      if (!client || loan.client_id !== client.id) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    // Parse repayment schedule if it's a string
    if (loan.repayment_schedule && typeof loan.repayment_schedule === 'string') {
      try {
        loan.repayment_schedule = JSON.parse(loan.repayment_schedule);
      } catch (e) {
        console.error('Error parsing repayment schedule:', e);
        loan.repayment_schedule = [];
      }
    }

    // Ensure repayments are sorted by installment number
    if (loan.repayments && loan.repayments.length > 0) {
      loan.repayments.sort((a, b) => (a.installment_number || 0) - (b.installment_number || 0));
    }

    res.json({
      success: true,
      data: { loan }
    });
  } catch (error) {
    console.error('Get loan error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loan',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Create loan (or loan request for borrowers)
router.post('/', authenticate, [
  body('client_id').optional().isInt().withMessage('Client ID must be a number'),
  body('amount').isFloat({ min: 0 }).withMessage('Valid amount is required'),
  body('interest_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('Valid interest rate is required'),
  body('term_months').isInt({ min: 1 }).withMessage('Valid term is required')
], async (req, res) => {
  try {
    // Log request body for debugging
    console.log('Loan creation request:', {
      body: req.body,
      userId: req.userId,
      userRole: req.user?.role
    });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      const errorMessages = errors.array().map(e => `${e.param}: ${e.msg}`).join(', ');
      return res.status(400).json({ 
        success: false, 
        message: `Validation failed: ${errorMessages}`,
        error: errorMessages,
        errors: errors.array() 
      });
    }

    const userRole = req.user?.role || 'user';
    let clientId = req.body.client_id ? parseInt(req.body.client_id) : null;

    // For borrower role, get their client_id automatically (by user_id or email fallback)
    if (userRole === 'borrower') {
      const client = await getBorrowerClient(req.userId, req.user?.email);
      if (!client) {
        return res.status(400).json({
          success: false,
          message: 'Client profile not found. Please contact support.'
        });
      }
      clientId = client.id;
      // For borrowers, set status to 'pending' (loan request)
      req.body.status = 'pending';
    } else {
      // For non-borrower roles, client_id is required
      if (!clientId || isNaN(clientId)) {
        return res.status(400).json({
          success: false,
          message: 'Client ID is required for loan creation.'
        });
      }

      // Verify client exists
      const client = await db.Client.findByPk(clientId);
      if (!client) {
        return res.status(400).json({
          success: false,
          message: 'Client not found. Please select a valid client.'
        });
      }
    }

    const loanCalculation = require('../services/loanCalculation');
    const { getLoanTypeConfig, calculateUpfrontAmount } = require('../config/loanTypes');
    
    // Generate unique loan number (check for existing numbers to avoid duplicates)
    let loanNumber;
    let attempts = 0;
    const maxAttempts = 100;
    
    // Get the highest existing loan number
    const lastLoan = await db.Loan.findOne({
      order: [['id', 'DESC']],
      attributes: ['loan_number']
    });
    
    let sequenceNumber = 1;
    if (lastLoan && lastLoan.loan_number) {
      // Extract number from last loan number (e.g., "LN000123" -> 123)
      const lastNumber = parseInt(lastLoan.loan_number.replace('LN', '')) || 0;
      sequenceNumber = lastNumber + 1;
    }
    
    do {
      loanNumber = `LN${String(sequenceNumber).padStart(6, '0')}`;
      
      // Check if this loan number already exists (including soft-deleted)
      const existingLoan = await db.Loan.findOne({ 
        where: { loan_number: loanNumber },
        paranoid: false // Check including soft-deleted
      });
      
      if (!existingLoan) {
        break; // Found a unique number
      }
      
      sequenceNumber++;
      attempts++;
    } while (attempts < maxAttempts);
    
    if (attempts >= maxAttempts) {
      // Fallback: use timestamp-based number
      const timestamp = Date.now();
      loanNumber = `LN${String(timestamp).slice(-6)}`;
      
      // Double-check this one too
      const existingLoan = await db.Loan.findOne({ 
        where: { loan_number: loanNumber },
        paranoid: false
      });
      if (existingLoan) {
        // Last resort: add random suffix
        loanNumber = `LN${String(timestamp).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
      }
    }

    const loanType = req.body.loan_type || 'personal';
    const loanTypeConfig = getLoanTypeConfig(loanType);
    
    // Validate required numeric fields
    if (!loanTypeConfig) {
      return res.status(400).json({
        success: false,
        message: `Invalid loan type: ${loanType}.`
      });
    }

    // Get loan amount (total requested)
    const loanAmount = parseFloat(req.body.amount);
    if (isNaN(loanAmount) || loanAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid loan amount is required (must be greater than 0).'
      });
    }
    
    // Get interest rate (from form or loan type config)
    let interestRate = parseFloat(req.body.interest_rate);
    if (isNaN(interestRate) || interestRate < 0) {
      interestRate = loanTypeConfig.interestRate || 0;
    }
    
    const termMonths = parseInt(req.body.term_months);
    if (isNaN(termMonths) || termMonths < 1) {
      return res.status(400).json({
        success: false,
        message: 'Valid loan term is required (must be at least 1 month).'
      });
    }

    const interestMethod = req.body.interest_method || loanTypeConfig.interestMethod || 'declining_balance';
    const paymentFrequency = req.body.payment_frequency || 'monthly';
    const disbursementDate = req.body.disbursement_date || new Date().toISOString().split('T')[0];
    
    // Handle currency - default to USD if not provided or invalid
    let currency = req.body.currency || 'USD';
    if (!['LRD', 'USD'].includes(currency)) {
      currency = 'USD'; // Default to USD if invalid
    }

    // Handle different loan types
    // Personal and Excess: 10% interest on loan amount, no upfront
    // Other loans: upfront is a fee, interest is calculated on full loan amount
    let scheduleData;
    let totalInterest;
    let totalAmount;
    let principal;
    let upfrontAmount;
    let upfrontPercentage;
    let defaultChargesPercentage;
    let defaultChargesAmount;
    
    if (loanType === 'personal' || loanType === 'excess') {
      // Personal/Excess loans: 10% interest calculated on full loan amount, no upfront
      // Interest is distributed: Personal (30% admin, 40% client, 30% general), Excess (20% admin, 30% client, 50% general)
      upfrontPercentage = 0;
      upfrontAmount = 0;
      principal = loanAmount; // Full loan amount (no upfront deduction)
      defaultChargesPercentage = 0;
      defaultChargesAmount = 0;
      
      // Generate schedule with interest calculated on the full loan amount
      try {
        scheduleData = loanCalculation.generateRepaymentSchedule(
          loanAmount, // Use full loan amount (no upfront deduction)
          interestRate, // 10% interest
          termMonths,
          interestMethod,
          paymentFrequency,
          disbursementDate
        );
        
        if (!scheduleData || !scheduleData.schedule || !Array.isArray(scheduleData.schedule) || scheduleData.schedule.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Failed to generate repayment schedule. Please check loan parameters.'
          });
        }
      } catch (scheduleError) {
        console.error('Schedule generation error:', scheduleError);
        return res.status(400).json({
          success: false,
          message: 'Failed to generate repayment schedule: ' + scheduleError.message
        });
      }
      
      // Total interest = schedule interest (calculated on loan amount)
      totalInterest = scheduleData.total_interest || 0;
      // Total amount = loan amount + interest
      totalAmount = scheduleData.total_amount || loanAmount;
    } else {
      // Other loan types: upfront is a fee, interest is calculated on full loan amount
      // Calculate upfront percentage and amount
      upfrontPercentage = parseFloat(req.body.upfront_percentage) || loanTypeConfig.upfrontPercentage;
      upfrontAmount = calculateUpfrontAmount(loanAmount, upfrontPercentage);
      
      // Principal remains the full loan amount (do not deduct upfront)
      principal = loanAmount;
      
      // Get default charges (only for Emergency and Micro loans)
      defaultChargesPercentage = loanTypeConfig.hasDefaultCharges 
        ? (parseFloat(req.body.default_charges_percentage) || 0)
        : 0;
      defaultChargesAmount = defaultChargesPercentage > 0 
        ? (principal * defaultChargesPercentage / 100)
        : 0;
      
      // Generate repayment schedule based on full loan amount
      try {
        scheduleData = loanCalculation.generateRepaymentSchedule(
          principal,
          interestRate,
          termMonths,
          interestMethod,
          paymentFrequency,
          disbursementDate
        );
        
        if (!scheduleData || !scheduleData.schedule || !Array.isArray(scheduleData.schedule) || scheduleData.schedule.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Failed to generate repayment schedule. Please check loan parameters.'
          });
        }
      } catch (scheduleError) {
        console.error('Schedule generation error:', scheduleError);
        return res.status(400).json({
          success: false,
          message: 'Failed to generate repayment schedule: ' + scheduleError.message
        });
      }
      
      // Total interest = schedule interest (calculated on full loan amount)
      totalInterest = scheduleData.total_interest || 0;
      // Total amount = principal + schedule interest + default charges
      totalAmount = (scheduleData.total_amount || principal) + defaultChargesAmount;
    }
    
    // Outstanding balance = principal + total interest (from schedule) + default charges
    // For Personal/Excess loans, principal is the loan amount and interest is calculated on it
    const outstandingBalance = principal + totalInterest + defaultChargesAmount;

    // Validate collateral_id if provided
    let collateralId = null;
    if (req.body.collateral_id) {
      const collateralIdInt = parseInt(req.body.collateral_id);
      if (!isNaN(collateralIdInt)) {
        // Verify collateral exists and belongs to the client
        const collateral = await db.Collateral.findByPk(collateralIdInt);
        if (collateral && collateral.client_id === clientId) {
          collateralId = collateralIdInt;
        } else if (collateral && collateral.client_id !== clientId) {
          return res.status(400).json({
            success: false,
            message: 'Selected collateral does not belong to the selected client.'
          });
        }
      }
    }

    // Use transaction to ensure atomicity and prevent race conditions
    const transaction = await db.sequelize.transaction();
    
    try {
      // Double-check loan number uniqueness within transaction
      const existingLoanInTransaction = await db.Loan.findOne({ 
        where: { loan_number: loanNumber },
        paranoid: false,
        transaction
      });
      
      if (existingLoanInTransaction) {
        // Regenerate loan number within transaction
        const lastLoanInTransaction = await db.Loan.findOne({
          order: [['id', 'DESC']],
          attributes: ['loan_number'],
          paranoid: false,
          transaction
        });
        
        let sequenceNumber = 1;
        if (lastLoanInTransaction && lastLoanInTransaction.loan_number) {
          const lastNumber = parseInt(lastLoanInTransaction.loan_number.replace('LN', '')) || 0;
          sequenceNumber = lastNumber + 1;
        }
        
        // Find next available number
        let newLoanNumber;
        let attempts = 0;
        do {
          newLoanNumber = `LN${String(sequenceNumber).padStart(6, '0')}`;
          const checkLoan = await db.Loan.findOne({ 
            where: { loan_number: newLoanNumber },
            paranoid: false,
            transaction
          });
          if (!checkLoan) {
            loanNumber = newLoanNumber;
            break;
          }
          sequenceNumber++;
          attempts++;
        } while (attempts < 100);
        
        if (attempts >= 100) {
          throw new Error('Unable to generate unique loan number after multiple attempts');
        }
      }

      // Prepare loan data, ensuring proper types
      const loanData = {
        loan_number: loanNumber,
        client_id: clientId, // Already validated and parsed
        amount: loanAmount, // Total loan amount requested
        principal_amount: principal, // Principal equals full loan amount
        interest_rate: interestRate,
        term_months: termMonths,
        loan_type: loanType,
        payment_frequency: paymentFrequency,
        interest_method: interestMethod,
        loan_purpose: req.body.loan_purpose ? String(req.body.loan_purpose).trim() : null,
        collateral_id: collateralId,
        disbursement_date: disbursementDate,
        branch_id: req.body.branch_id ? parseInt(req.body.branch_id) : (req.user?.branch_id || null),
        status: userRole === 'borrower' ? 'pending' : 'pending',
        outstanding_balance: outstandingBalance, // Principal + total interest + default charges
        monthly_payment: scheduleData.monthly_payment || 0,
        total_interest: totalInterest || 0, // Total interest (calculated on loan amount or principal)
        total_amount: totalAmount || loanAmount, // Total amount (loan amount + interest + charges)
        repayment_schedule: JSON.stringify(scheduleData.schedule || []),
        application_date: disbursementDate,
        notes: req.body.notes ? String(req.body.notes).trim() : null,
        created_by: req.userId,
        upfront_percentage: upfrontPercentage,
        upfront_amount: upfrontAmount,
        default_charges_percentage: defaultChargesPercentage,
        default_charges_amount: defaultChargesAmount,
        currency: currency // Currency for the loan (LRD or USD)
      };

      const loan = await db.Loan.create(loanData, { transaction });

      // Create repayment schedule entries
      try {
        for (const scheduleItem of scheduleData.schedule) {
          await db.LoanRepayment.create({
            loan_id: loan.id,
            repayment_number: `${loanNumber}-${String(scheduleItem.installment_number).padStart(3, '0')}`,
            installment_number: scheduleItem.installment_number,
            amount: scheduleItem.total_payment,
            principal_amount: scheduleItem.principal_amount,
            interest_amount: scheduleItem.interest_amount,
            due_date: scheduleItem.due_date,
            payment_date: null,
            status: 'pending',
            created_by: req.userId
          }, { transaction });
        }
      } catch (repaymentError) {
        console.error('Error creating repayment schedule entries:', repaymentError);
        throw repaymentError; // Rollback transaction if repayments fail
      }
      
      // Commit transaction
      await transaction.commit();

      const isBorrowerRequest = userRole === 'borrower';
      
      res.status(201).json({
        success: true,
        message: isBorrowerRequest 
          ? 'Loan request submitted successfully! It will be reviewed by a loan officer, head of micro loan, or admin.'
          : 'Loan created successfully',
        data: { 
          loan,
          repayment_schedule: scheduleData.schedule,
          schedule_summary: {
            total_interest: totalInterest,
            total_amount: totalAmount,
            monthly_payment: scheduleData.monthly_payment,
            upfront_amount: upfrontAmount,
            principal_amount: principal,
            default_charges_amount: defaultChargesAmount
          }
        }
      });
    } catch (transactionError) {
      // Rollback transaction on error
      await transaction.rollback();
      throw transactionError; // Re-throw to be caught by outer catch block
    }
  } catch (error) {
    console.error('Create loan error:', error);
    console.error('Error stack:', error.stack);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    
    // Check for specific error types
    let errorMessage = 'Failed to create loan. Please try again or contact support.';
    let statusCode = 500;
    let errorDetails = {};
    
    if (error.name === 'SequelizeDatabaseError') {
      // Database constraint errors (like ENUM value not found)
      if (error.message && (error.message.includes('enum') || error.message.includes('loan_type'))) {
        errorMessage = 'Invalid loan type selected. Please ensure the database has been migrated or select a different loan type.';
        console.error('ENUM error detected - database may need migration');
      } else if (error.message && error.message.includes('null value')) {
        errorMessage = 'Required field is missing. Please check all required fields are filled.';
        statusCode = 400;
      } else {
        errorMessage = error.message || 'Database error occurred. Please try again.';
      }
    } else if (error.name === 'SequelizeValidationError') {
      const validationMessages = error.errors 
        ? error.errors.map(e => `${e.path || 'Field'}: ${e.message}`).join(', ')
        : 'Validation failed';
      errorMessage = `Validation failed: ${validationMessages}`;
      statusCode = 400;
      errorDetails.validationErrors = error.errors;
    } else if (error.name === 'SequelizeUniqueConstraintError') {
      // If duplicate loan number error, try to generate a new one and retry once
      if (error.message && error.message.includes('loan_number')) {
        console.log('Duplicate loan number detected, attempting to generate new number...');
        try {
          // Regenerate loan number
          const lastLoan = await db.Loan.findOne({
            order: [['id', 'DESC']],
            attributes: ['loan_number'],
            paranoid: false
          });
          
          let sequenceNumber = 1;
          if (lastLoan && lastLoan.loan_number) {
            const lastNumber = parseInt(lastLoan.loan_number.replace('LN', '')) || 0;
            sequenceNumber = lastNumber + 1;
          }
          
          let newLoanNumber;
          let attempts = 0;
          do {
            newLoanNumber = `LN${String(sequenceNumber).padStart(6, '0')}`;
            const existingLoan = await db.Loan.findOne({ 
              where: { loan_number: newLoanNumber },
              paranoid: false
            });
            if (!existingLoan) break;
            sequenceNumber++;
            attempts++;
          } while (attempts < 100);
          
          errorMessage = `A loan with this number already exists. Please try again with loan number: ${newLoanNumber}, or contact support to resolve duplicate loan numbers.`;
        } catch (retryError) {
          errorMessage = 'A loan with this number already exists. The system is attempting to resolve this automatically. Please try again in a moment or contact support.';
          console.error('Error while resolving duplicate loan number:', retryError);
        }
      } else {
        errorMessage = 'A duplicate record was detected. Please try again or contact support.';
      }
      statusCode = 400;
    } else if (error.name === 'SequelizeForeignKeyConstraintError') {
      errorMessage = 'Invalid reference (client, branch, or collateral not found). Please check your selections.';
      statusCode = 400;
    } else if (error.message) {
      errorMessage = error.message;
      if (error.message.includes('Cannot read property') || error.message.includes('undefined')) {
        errorMessage = 'An unexpected error occurred. Please check all fields are properly filled.';
      }
    }
    
    // Ensure error message is meaningful
    if (!errorMessage || errorMessage.length < 10) {
      errorMessage = 'Failed to create loan. Please check all required fields and try again.';
    }
    
    const response = {
      success: false,
      message: errorMessage,
      error: errorMessage
    };
    
    // Add detailed error info in development
    if (process.env.NODE_ENV === 'development') {
      response.details = {
        name: error.name,
        message: error.message,
        ...errorDetails
      };
    }
    
    res.status(statusCode).json(response);
  }
});

// Approve loan – admin, head_micro_loan, or supervisor only (not micro_loan_officer)
router.post('/:id/approve', authenticate, authorize('admin', 'head_micro_loan', 'supervisor'), async (req, res) => {
  try {
    const loan = await db.Loan.findByPk(req.params.id);
    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    await loan.update({ status: 'approved' });

    res.json({
      success: true,
      message: 'Loan approved successfully',
      data: { loan }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to approve loan',
      error: error.message
    });
  }
});

// Reject loan (cancel pending) – admin, head_micro_loan, or supervisor only
router.post('/:id/reject', authenticate, authorize('admin', 'head_micro_loan', 'supervisor'), async (req, res) => {
  try {
    const loan = await db.Loan.findByPk(req.params.id);
    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }
    if (loan.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Only pending loans can be rejected'
      });
    }

    await loan.update({ status: 'cancelled' });

    res.json({
      success: true,
      message: 'Loan rejected successfully',
      data: { loan }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to reject loan',
      error: error.message
    });
  }
});

// Disburse loan
router.post('/:id/disburse', authenticate, authorize('admin', 'head_micro_loan', 'branch_manager', 'general_manager', 'finance'), async (req, res) => {
  try {
    const loan = await db.Loan.findByPk(req.params.id);
    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    // Disbursement should happen from approved state only.
    if (loan.status === 'disbursed' || loan.status === 'active' || loan.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: `Loan cannot be disbursed because current status is "${loan.status}".`
      });
    }

    if (loan.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Only approved loans can be disbursed.'
      });
    }

    const updatePayload = {
      status: 'disbursed',
      disbursement_date: new Date().toISOString().split('T')[0]
    };
    // Ensure outstanding_balance is set so repayments decrease it correctly
    const currentOutstanding = parseFloat(loan.outstanding_balance || 0);
    if (currentOutstanding <= 0) {
      const totalAmount = parseFloat(loan.total_amount || loan.amount || 0);
      const principal = parseFloat(loan.amount || 0);
      updatePayload.outstanding_balance = totalAmount > 0 ? totalAmount : principal;
    }

    await loan.update(updatePayload);

    res.json({
      success: true,
      message: 'Loan disbursed successfully',
      data: { loan: await db.Loan.findByPk(loan.id) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to disburse loan',
      error: error.message
    });
  }
});

// Calculate repayment schedule (preview)
router.post('/calculate-schedule', authenticate, async (req, res) => {
  try {
    const loanCalculation = require('../services/loanCalculation');
    const { getLoanTypeConfig, calculateUpfrontAmount } = require('../config/loanTypes');
    
    const { 
      loan_amount, 
      upfront_percentage, 
      loan_type,
      interest_rate, 
      term_months, 
      interest_method, 
      payment_frequency, 
      start_date,
      default_charges_percentage
    } = req.body;

    // If loan_amount and upfront_percentage are provided, calculate upfront
    let principal = parseFloat(req.body.principal) || 0;
    let upfrontAmount = 0;
    let totalInterest = 0;
    let totalAmount = 0;
    
    if (loan_amount && upfront_percentage) {
      const loanAmount = parseFloat(loan_amount);
      const upfrontPct = parseFloat(upfront_percentage);
      upfrontAmount = calculateUpfrontAmount(loanAmount, upfrontPct);
      principal = loanAmount; // Principal remains full loan amount
    }

    if (!principal || principal <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Principal amount is required'
      });
    }

    const loanType = loan_type || 'personal';
    const loanTypeConfig = getLoanTypeConfig(loanType);
    const interestRate = parseFloat(interest_rate) || loanTypeConfig.interestRate;
    
    // Calculate default charges if applicable
    const defaultChargesPercentage = loanTypeConfig.hasDefaultCharges 
      ? (parseFloat(default_charges_percentage) || 0)
      : 0;
    const defaultChargesAmount = defaultChargesPercentage > 0 
      ? (principal * defaultChargesPercentage / 100)
      : 0;

    // Generate schedule
    let scheduleData;
    if (loanType === 'personal' && interestRate === 0) {
      // Personal loan: upfront is interest
      totalInterest = upfrontAmount;
      scheduleData = loanCalculation.generateRepaymentSchedule(
        principal,
        0,
        term_months,
        interest_method || 'declining_balance',
        payment_frequency || 'monthly',
        start_date
      );
      scheduleData.total_interest = totalInterest;
      scheduleData.total_amount = loan_amount || (principal + upfrontAmount);
      totalAmount = scheduleData.total_amount;
    } else {
      scheduleData = loanCalculation.generateRepaymentSchedule(
        principal,
        interestRate,
        term_months,
        interest_method || 'declining_balance',
        payment_frequency || 'monthly',
        start_date
      );
      totalInterest = scheduleData.total_interest;
      totalAmount = scheduleData.total_amount + defaultChargesAmount;
    }

    res.json({
      success: true,
      data: {
        ...scheduleData,
        total_interest: totalInterest,
        total_amount: totalAmount,
        upfront_amount: upfrontAmount,
        principal_amount: principal,
        default_charges_amount: defaultChargesAmount
      }
    });
  } catch (error) {
    console.error('Calculate schedule error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate schedule',
      error: error.message
    });
  }
});

// Get repayment schedule
router.get('/:id/schedule', authenticate, async (req, res) => {
  try {
    const loan = await db.Loan.findByPk(req.params.id);
    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    // Borrower can only view their own loan schedule
    if (req.user?.role === 'borrower') {
      const client = await getBorrowerClient(req.userId, req.user?.email);
      if (!client || loan.client_id !== client.id) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    // Parse repayment_schedule if it's a string
    let schedule = [];
    try {
      if (loan.repayment_schedule) {
        schedule = typeof loan.repayment_schedule === 'string' 
          ? JSON.parse(loan.repayment_schedule) 
          : loan.repayment_schedule;
      }
    } catch (parseError) {
      console.error('Error parsing repayment schedule:', parseError);
      schedule = [];
    }

    // If no schedule in loan, try to get from repayments
    if (!schedule || schedule.length === 0) {
      const repayments = await db.LoanRepayment.findAll({
        where: { loan_id: loan.id },
        order: [['installment_number', 'ASC']]
      });
      
      schedule = repayments.map(r => ({
        installment_number: r.installment_number,
        due_date: r.due_date,
        principal_payment: parseFloat(r.principal_amount || 0),
        interest_payment: parseFloat(r.interest_amount || 0),
        total_payment: parseFloat(r.amount || 0),
        outstanding_balance: 0, // Would need to calculate
        status: r.status || 'pending',
        paid_amount: r.payment_date ? parseFloat(r.amount || 0) : 0,
        payment_date: r.payment_date
      }));
    }

    const repayments = await db.LoanRepayment.findAll({
      where: { loan_id: loan.id },
      order: [['installment_number', 'ASC']]
    });

    const scheduleWithPayments = schedule.map((item) => {
      const repayment = repayments.find(r => r.installment_number === item.installment_number);
      return {
        ...item,
        status: repayment ? repayment.status : (item.status || 'pending'),
        paid_amount: repayment && repayment.payment_date ? parseFloat(repayment.amount || 0) : 0,
        payment_date: repayment ? repayment.payment_date : null
      };
    });

    res.json({
      success: true,
      data: {
        loan: {
          loan_number: loan.loan_number,
          amount: loan.amount,
          outstanding_balance: loan.outstanding_balance,
          interest_rate: loan.interest_rate,
          term_months: loan.term_months,
          interest_method: loan.interest_method,
          monthly_payment: loan.monthly_payment,
          total_interest: loan.total_interest,
          total_amount: loan.total_amount
        },
        schedule: scheduleWithPayments
      }
    });
  } catch (error) {
    console.error('Get schedule error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch schedule',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Loan repayment
router.post('/:id/repay', authenticate, [
  body('amount').isFloat({ min: 0.01 }).withMessage('Valid payment amount is required'),
  body('payment_method').optional().isIn(['cash', 'bank_transfer', 'mobile_money', 'check']),
  body('payment_date').optional().matches(/^\d{4}-\d{2}-\d{2}(T|\s|$)/).withMessage('Invalid date format (use YYYY-MM-DD)')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Repayment validation errors:', errors.array());
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    // Ensure amount is a number
    const paymentAmount = parseFloat(req.body.amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid payment amount is required'
      });
    }

    const loan = await db.Loan.findByPk(req.params.id, {
      include: [{ model: db.Client, as: 'client', required: false }]
    });

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    if (loan.status !== 'active' && loan.status !== 'disbursed' && loan.status !== 'overdue') {
      return res.status(400).json({
        success: false,
        message: 'Loan is not active for repayment'
      });
    }

    // Borrower can only repay their own loan
    if (req.user?.role === 'borrower') {
      const client = await getBorrowerClient(req.userId, req.user?.email);
      if (!client || loan.client_id !== client.id) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    const outstandingBalance = parseFloat(loan.outstanding_balance ?? loan.total_amount ?? loan.amount ?? 0);

    if (paymentAmount > outstandingBalance) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount exceeds outstanding balance'
      });
    }

    // Find next due repayment (pending or partial), or allow repayment without schedule (ad-hoc)
    let nextRepayment = await db.LoanRepayment.findOne({
      where: {
        loan_id: loan.id,
        status: { [Op.in]: ['pending', 'partial'] }
      },
      order: [['due_date', 'ASC'], ['installment_number', 'ASC']]
    });

    let interestAmount = 0;
    let principalAmount = paymentAmount;
    let penaltyAmount = 0;

    // Normalize payment date: YYYY-MM-DD string for DATEONLY, Date for DATE
    const paymentDateStr = req.body.payment_date && /^\d{4}-\d{2}-\d{2}/.test(String(req.body.payment_date))
      ? String(req.body.payment_date).substring(0, 10)
      : new Date().toISOString().split('T')[0];
    const paymentDateForDb = req.body.payment_date ? new Date(req.body.payment_date) : new Date();
    if (isNaN(paymentDateForDb.getTime())) paymentDateForDb.setTime(Date.now());

    const paymentMethod = ['cash', 'bank_transfer', 'mobile_money', 'check'].includes(req.body.payment_method)
      ? req.body.payment_method
      : 'cash';

    if (nextRepayment) {
      // Apply to schedule: use schedule interest/principal split
      interestAmount = Math.min(paymentAmount, parseFloat(nextRepayment.interest_amount || 0));
      principalAmount = paymentAmount - interestAmount;
      penaltyAmount = 0;

      const remainingAmount = parseFloat(nextRepayment.amount) - paymentAmount;
      if (remainingAmount <= 0.01) {
        await nextRepayment.update({
          amount: paymentAmount,
          principal_amount: principalAmount,
          interest_amount: interestAmount,
          penalty_amount: penaltyAmount,
          payment_date: paymentDateStr,
          payment_method: paymentMethod,
          status: 'completed',
          transaction_id: null
        });
      } else {
        await nextRepayment.update({
          amount: paymentAmount,
          principal_amount: principalAmount,
          interest_amount: interestAmount,
          penalty_amount: penaltyAmount,
          payment_date: paymentDateStr,
          payment_method: paymentMethod,
          status: 'partial'
        });
      }
    }

    // Generate unique transaction number (avoid 500 from duplicate TXN in production)
    let transactionNumber;
    try {
      const lastTxn = await db.Transaction.findOne({
        attributes: ['transaction_number'],
        order: [['id', 'DESC']],
        paranoid: false
      });
      let seq = 1;
      if (lastTxn?.transaction_number) {
        const num = parseInt(String(lastTxn.transaction_number).replace(/\D/g, ''), 10) || 0;
        seq = num + 1;
      }
      let attempts = 0;
      do {
        transactionNumber = `TXN${String(seq).padStart(8, '0')}`;
        const exists = await db.Transaction.findOne({ where: { transaction_number: transactionNumber }, paranoid: false });
        if (!exists) break;
        seq++;
        attempts++;
      } while (attempts < 100);
      if (!transactionNumber) transactionNumber = `TXN${String(Date.now()).slice(-8)}`;
    } catch (e) {
      transactionNumber = `TXN${String(Date.now()).slice(-8)}`;
    }

    let transaction;
    try {
      transaction = await db.Transaction.create({
        transaction_number: transactionNumber,
        client_id: loan.client_id,
        loan_id: loan.id,
        type: 'loan_payment',
        amount: paymentAmount,
        currency: loan.currency || 'USD',
        description: `Loan repayment for ${loan.loan_number}`,
        transaction_date: paymentDateForDb,
        status: 'completed',
        branch_id: loan.branch_id || null,
        created_by: req.userId
      });
    } catch (createErr) {
      if (createErr.name === 'SequelizeUniqueConstraintError' && createErr.fields?.transaction_number) {
        transactionNumber = `TXN${String(Date.now()).slice(-8)}`;
        transaction = await db.Transaction.create({
          transaction_number: transactionNumber,
          client_id: loan.client_id,
          loan_id: loan.id,
          type: 'loan_payment',
          amount: paymentAmount,
          currency: loan.currency || 'USD',
          description: `Loan repayment for ${loan.loan_number}`,
          transaction_date: paymentDateForDb,
          status: 'completed',
          branch_id: loan.branch_id || null,
          created_by: req.userId
        });
      } else {
        throw createErr;
      }
    }

    // Link transaction to repayment: either the schedule row we updated or a new ad-hoc row
    const loanCurrency = loan.currency || 'USD';
    if (nextRepayment) {
      await nextRepayment.update({ transaction_id: transaction.id });
    } else {
      // No schedule: create one ad-hoc repayment record for this payment (unique repayment_number)
      const adHocRepaymentNumber = `${loan.loan_number}-ADHOC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      nextRepayment = await db.LoanRepayment.create({
        loan_id: loan.id,
        repayment_number: adHocRepaymentNumber,
        installment_number: 0,
        amount: paymentAmount,
        principal_amount: principalAmount,
        interest_amount: interestAmount,
        penalty_amount: penaltyAmount,
        payment_date: paymentDateStr,
        payment_method: paymentMethod,
        status: 'completed',
        transaction_id: transaction.id,
        due_date: paymentDateStr,
        created_by: req.userId
      });
    }

    // Repayment only affects this loan (principal + interest). Interest is passed to borrowers via separate transactions.
    // Reduce outstanding by full payment amount so balance reaches zero when total repayments equal total_amount (principal + interest)
    const totalAmountDue = parseFloat(loan.total_amount ?? loan.amount ?? 0);
    const newOutstanding = Math.max(0, outstandingBalance - paymentAmount);
    const newTotalPaid = parseFloat(loan.total_paid || 0) + paymentAmount;

    // Close loan automatically when total (principal + interest) is fully repaid
    const isFullyPaid = newOutstanding <= 0.01 || newTotalPaid >= Math.max(0, totalAmountDue - 0.01);
    const newStatus = isFullyPaid ? 'completed' : loan.status;

    await loan.update({
      outstanding_balance: isFullyPaid ? 0 : newOutstanding,
      total_paid: newTotalPaid,
      status: newStatus
    });

    await syncOverdueLoanStatuses(db);

    // Microfinance loan (client without savings): 100% of interest → company revenue
    if (interestAmount > 0) {
      const hasSavings = await clientHasSavings(loan.client_id);
      if (!hasSavings) {
        await createRevenue({
          source: REVENUE_SOURCES.MICROFINANCE_INTEREST,
          amount: interestAmount,
          currency: loanCurrency,
          transaction_id: transaction.id,
          loan_id: loan.id,
          description: `Microfinance loan interest from repayment for ${loan.loan_number}`,
          revenue_date: paymentDateForDb,
          created_by: req.userId
        });
      }
    }

    // Notify client (Notification model requires user_id and type in info|success|warning|error)
    const notifyUserId = loan.client?.user_id;
    const finalOutstanding = isFullyPaid ? 0 : newOutstanding;
    if (notifyUserId) {
      try {
        await db.Notification.create({
          user_id: notifyUserId,
          title: 'Loan Repayment Received',
          message: `Your payment of $${paymentAmount.toFixed(2)} for loan ${loan.loan_number} has been received. Outstanding balance: $${finalOutstanding.toFixed(2)}.`,
          type: 'success',
          is_read: false
        });
      } catch (notifyErr) {
        console.error('Repayment notification failed:', notifyErr);
      }
    }

    res.json({
      success: true,
      message: isFullyPaid ? 'Repayment processed. Loan fully paid and completed.' : 'Repayment processed successfully',
      data: {
        repayment: nextRepayment,
        transaction,
        loan: {
          outstanding_balance: finalOutstanding,
          total_paid: newTotalPaid,
          status: newStatus
        },
        receipt: {
          transaction_number: transactionNumber,
          loan_number: loan.loan_number,
          client_name: `${loan.client?.first_name} ${loan.client?.last_name}`,
          amount: paymentAmount,
          principal: principalAmount,
          interest: interestAmount,
          penalty: penaltyAmount,
          date: transaction.transaction_date,
          outstanding_balance: finalOutstanding,
          payment_method: paymentMethod,
          description: req.body.description || `Loan repayment for ${loan.loan_number}`
        }
      }
    });
  } catch (error) {
    console.error('Repayment error:', error);
    console.error('Repayment error name:', error?.name);
    console.error('Repayment error message:', error?.message);
    const isDev = process.env.NODE_ENV === 'development';
    let message = 'Failed to process repayment. Please try again.';
    if (error?.name === 'SequelizeUniqueConstraintError') {
      message = 'A duplicate transaction or repayment was detected. Please try again.';
    } else if (error?.name === 'SequelizeValidationError') {
      message = error.message || 'Invalid data for repayment.';
    } else if (error?.message) {
      message = isDev ? error.message : message;
    }
    res.status(500).json({
      success: false,
      message,
      error: isDev ? error.message : undefined
    });
  }
});

// Update loan – admin, micro_loan_officer, or head_micro_loan can edit/update all loans and loan requests
router.put('/:id', authenticate, authorize('admin', 'micro_loan_officer', 'head_micro_loan'), async (req, res) => {
  try {
    const loan = await db.Loan.findByPk(req.params.id);
    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    const loanCalculation = require('../services/loanCalculation');

    const toNum = (v, def) => {
      if (v === undefined || v === null || v === '') return def;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) ? n : def;
    };
    const toInt = (v, def) => {
      if (v === undefined || v === null || v === '') return def;
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      return Number.isInteger(n) ? n : def;
    };

    const loanAmount = toNum(loan.amount, 0);
    const loanRate = toNum(loan.interest_rate, 0);
    const loanTerm = toInt(loan.term_months, 1);

    const principal = toNum(req.body.amount, loanAmount);
    const interestRate = toNum(req.body.interest_rate, loanRate);
    const termMonths = toInt(req.body.term_months, loanTerm);

    if (principal <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Loan amount must be greater than zero',
        errors: [{ param: 'amount', msg: 'Valid amount is required' }]
      });
    }
    if (interestRate < 0 || interestRate > 100) {
      return res.status(400).json({
        success: false,
        message: 'Interest rate must be between 0 and 100',
        errors: [{ param: 'interest_rate', msg: 'Valid interest rate is required' }]
      });
    }
    if (termMonths < 1) {
      return res.status(400).json({
        success: false,
        message: 'Term must be at least 1 month',
        errors: [{ param: 'term_months', msg: 'Valid term is required' }]
      });
    }

    const interestMethod = req.body.interest_method || loan.interest_method || 'declining_balance';
    const paymentFrequency = req.body.payment_frequency || loan.payment_frequency || 'monthly';
    const disbursementDate = loan.disbursement_date || loan.application_date || new Date().toISOString().split('T')[0];

    let scheduleData;
    try {
      scheduleData = loanCalculation.generateRepaymentSchedule(
        principal,
        interestRate,
        termMonths,
        interestMethod,
        paymentFrequency,
        disbursementDate
      );
    } catch (calcError) {
      console.error('Schedule calculation error:', calcError);
      return res.status(400).json({
        success: false,
        message: calcError.message || 'Invalid loan terms for schedule calculation',
        errors: []
      });
    }

    await db.LoanRepayment.destroy({ where: { loan_id: loan.id } });

    const schedule = Array.isArray(scheduleData.schedule) ? scheduleData.schedule : [];
    for (const scheduleItem of schedule) {
        await db.LoanRepayment.create({
          loan_id: loan.id,
          repayment_number: `${loan.loan_number}-${String(scheduleItem.installment_number).padStart(3, '0')}`,
          installment_number: scheduleItem.installment_number,
          amount: scheduleItem.total_payment,
          principal_amount: scheduleItem.principal_amount ?? scheduleItem.principal_payment,
          interest_amount: scheduleItem.interest_amount ?? scheduleItem.interest_payment,
          due_date: scheduleItem.due_date,
          payment_date: null,
          status: 'pending',
          created_by: req.userId
        });
    }

    const loanTypeConfig = getLoanTypeConfig(req.body.loan_type || loan.loan_type);
    const defaultChargesPct = loanTypeConfig.hasDefaultCharges
      ? toNum(req.body.default_charges_percentage, toNum(loan.default_charges_percentage, 0))
      : 0;
    const defaultChargesAmount = principal * (defaultChargesPct / 100);
    const totalAmount = (scheduleData.total_amount || 0) + defaultChargesAmount;
    const totalPaid = toNum(loan.total_paid, 0);
    const outstandingBalance = Math.max(0, totalAmount - totalPaid);

    const updatePayload = {
      amount: principal,
      principal_amount: principal,
      interest_rate: interestRate,
      term_months: termMonths,
      interest_method: interestMethod,
      payment_frequency: paymentFrequency,
      monthly_payment: scheduleData.monthly_payment || 0,
      total_interest: scheduleData.total_interest || 0,
      total_amount: totalAmount,
      outstanding_balance: outstandingBalance,
      repayment_schedule: JSON.stringify(schedule),
      default_charges_percentage: defaultChargesPct,
      default_charges_amount: defaultChargesAmount
    };
    if (req.body.notes !== undefined) updatePayload.notes = req.body.notes == null ? null : String(req.body.notes).trim();
    if (req.body.loan_purpose !== undefined) updatePayload.loan_purpose = req.body.loan_purpose == null ? null : String(req.body.loan_purpose).trim();
    if (req.body.loan_type !== undefined) updatePayload.loan_type = req.body.loan_type;
    if (req.body.currency !== undefined) updatePayload.currency = req.body.currency || 'USD';
    if (req.body.disbursement_date !== undefined) updatePayload.disbursement_date = req.body.disbursement_date || null;
    if (req.body.branch_id !== undefined) {
      const b = req.body.branch_id;
      const bId = (b === '' || b === null) ? null : (Number.isInteger(b) ? b : parseInt(b, 10));
      updatePayload.branch_id = (bId !== undefined && !Number.isNaN(bId)) ? bId : null;
    }
    if (req.body.collateral_id !== undefined) {
      const c = req.body.collateral_id;
      const cId = (c === '' || c === null) ? null : (Number.isInteger(c) ? c : parseInt(c, 10));
      updatePayload.collateral_id = (cId !== undefined && !Number.isNaN(cId)) ? cId : null;
    }

    await loan.update(updatePayload);

    const updatedLoan = await db.Loan.findByPk(loan.id, {
      include: [{ model: db.Client, as: 'client', required: false }]
    });

    res.json({
      success: true,
      message: 'Loan updated successfully',
      data: { loan: updatedLoan }
    });
  } catch (error) {
    console.error('Update loan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update loan',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Delete loan (soft delete)
router.delete('/:id', authenticate, authorize('admin', 'head_micro_loan'), async (req, res) => {
  try {
    const loan = await db.Loan.findByPk(req.params.id);
    if (!loan) {
      return res.status(404).json({
        success: false,
        message: 'Loan not found'
      });
    }

    // Also delete associated repayments
    await db.LoanRepayment.destroy({ where: { loan_id: loan.id } });
    
    await loan.destroy(); // Soft delete with paranoid

    res.json({
      success: true,
      message: 'Loan deleted successfully'
    });
  } catch (error) {
    console.error('Delete loan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete loan',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Delete loan by loan number (for fixing duplicates - must be before /:id route)
router.delete('/by-number/:loanNumber', authenticate, authorize('admin', 'head_micro_loan'), async (req, res) => {
  try {
    const { loanNumber } = req.params;
    
    const loan = await db.Loan.findOne({ 
      where: { loan_number: loanNumber },
      paranoid: false // Include soft-deleted
    });
    
    if (!loan) {
      return res.status(404).json({
        success: false,
        message: `Loan with number ${loanNumber} not found`
      });
    }

    // Also delete associated repayments
    await db.LoanRepayment.destroy({ where: { loan_id: loan.id } });
    
    // Force delete if already soft-deleted, otherwise soft delete
    const wasDeleted = loan.deleted_at !== null;
    await loan.destroy({ force: wasDeleted });

    res.json({
      success: true,
      message: `Loan ${loanNumber} deleted successfully`,
      data: { loan_number: loanNumber, loan_id: loan.id, was_permanently_deleted: wasDeleted }
    });
  } catch (error) {
    console.error('Delete loan by number error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete loan',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Check for duplicate loan numbers (admin utility)
router.get('/duplicates/check', authenticate, authorize('admin'), async (req, res) => {
  try {
    // Find all loans grouped by loan_number
    const allLoans = await db.Loan.findAll({
      attributes: ['id', 'loan_number', 'client_id', 'amount', 'status', 'created_at'],
      order: [['created_at', 'DESC']],
      paranoid: false // Include soft-deleted
    });
    
    // Group by loan_number to find duplicates
    const loanNumberMap = {};
    allLoans.forEach(loan => {
      if (!loanNumberMap[loan.loan_number]) {
        loanNumberMap[loan.loan_number] = [];
      }
      loanNumberMap[loan.loan_number].push({
        id: loan.id,
        client_id: loan.client_id,
        amount: loan.amount,
        status: loan.status,
        created_at: loan.created_at,
        deleted_at: loan.deleted_at
      });
    });
    
    // Find duplicates
    const duplicates = [];
    Object.keys(loanNumberMap).forEach(loanNumber => {
      if (loanNumberMap[loanNumber].length > 1) {
        duplicates.push({
          loan_number: loanNumber,
          count: loanNumberMap[loanNumber].length,
          loans: loanNumberMap[loanNumber]
        });
      }
    });
    
    res.json({
      success: true,
      data: {
        duplicates,
        duplicate_count: duplicates.length,
        total_duplicate_loans: duplicates.reduce((sum, dup) => sum + dup.count - 1, 0)
      }
    });
  } catch (error) {
    console.error('Check duplicates error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check for duplicate loans',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;

