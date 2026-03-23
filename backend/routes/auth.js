const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Production-safe limits for public auth endpoints
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many signup attempts. Please try again later.'
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 30 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.'
  }
});

// Register
router.post('/register', registerLimiter, [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('username').optional().isString(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').optional().equals('borrower').withMessage('Only borrower signup is allowed')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, role, branch_id } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const rawUsername = req.body.username ? String(req.body.username).trim().toLowerCase() : '';
    let usernameBase = rawUsername || normalizedEmail.split('@')[0];
    if (!usernameBase) usernameBase = 'user';
    usernameBase = usernameBase.replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'user';

    // Check if email already exists first
    const existingByEmail = await db.User.findOne({
      where: { email: normalizedEmail }
    });

    if (existingByEmail) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Ensure username is unique by suffixing when needed
    let username = usernameBase;
    let counter = 1;
    while (counter <= 1000) {
      const existingByUsername = await db.User.findOne({ where: { username } });
      if (!existingByUsername) break;
      username = `${usernameBase}${counter}`;
      counter += 1;
    }
    if (counter > 1000) {
      return res.status(500).json({
        success: false,
        message: 'Could not generate unique username. Please try again.'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await db.User.create({
      name,
      email: normalizedEmail,
      username,
      password: hashedPassword,
      role: 'borrower',
      branch_id: null,
      is_active: true,
      email_verified_at: new Date()
    });

    // If borrower, create a client record linked to this user so dashboard and records work
    const effectiveRole = 'borrower';
    if (effectiveRole === 'borrower') {
      try {
        // Generate unique client number (checks soft-deleted as well)
        let clientNumber = null;
        let seq = 1;
        const lastClient = await db.Client.findOne({
          attributes: ['client_number'],
          order: [['id', 'DESC']],
          paranoid: false
        });
        if (lastClient?.client_number) {
          const num = parseInt(String(lastClient.client_number).replace(/\D/g, ''), 10) || 0;
          seq = num + 1;
        }
        let attempts = 0;
        while (attempts < 100 && !clientNumber) {
          const candidate = `CL${String(seq).padStart(6, '0')}`;
          const exists = await db.Client.findOne({
            where: { client_number: candidate },
            paranoid: false
          });
          if (!exists) {
            clientNumber = candidate;
            break;
          }
          seq++;
          attempts++;
        }
        if (!clientNumber) {
          clientNumber = `CL${String(Date.now()).slice(-6)}`;
        }
        const nameParts = (name || '').trim().split(/\s+/);
        const firstName = nameParts[0] || name;
        const lastName = nameParts.slice(1).join(' ') || 'Client';
        await db.Client.create({
          client_number: clientNumber,
          first_name: firstName,
          last_name: lastName,
          email: normalizedEmail,
          phone: null,
          status: 'active',
          kyc_status: 'pending',
          branch_id: branch_id || null,
          user_id: user.id
        });
      } catch (clientErr) {
        console.error('Error creating client for borrower on register:', clientErr);
      }
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          username: user.username,
          role: user.role
        },
        token
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: error.message
    });
  }
});

// Login
router.post('/login', loginLimiter, [
  body('email').notEmpty().withMessage('Email is required').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    console.log('=== LOGIN ATTEMPT ===');
    console.log('Email:', req.body.email);
    console.log('Body:', JSON.stringify(req.body));
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false, 
        message: errors.array()[0].msg || 'Validation failed',
        errors: errors.array() 
      });
    }

    const { email, password } = req.body;
    console.log('Looking for user with email:', email);

    // Find user - simplified approach
    let user;
    try {
      const emailLower = email.toLowerCase().trim();
      
      // Try to find user by email or username (case-insensitive)
      // First, try exact match
      user = await db.User.findOne({
        where: {
          [Op.or]: [
            { email: emailLower },
            { username: emailLower }
          ]
        },
        attributes: { exclude: [] }
      });
      
      // If not found, try case-insensitive search by getting all and filtering
      if (!user) {
        const allUsers = await db.User.findAll({
          attributes: { exclude: [] }
        });
        
        user = allUsers.find(u => 
          (u.email && u.email.toLowerCase() === emailLower) || 
          (u.username && u.username.toLowerCase() === emailLower)
        );
      }
      
      console.log('User found:', user ? 'Yes' : 'No');
      if (user) {
        console.log('User email:', user.email, 'Username:', user.username, 'Has password:', !!user.password, 'Is active:', user.is_active);
      } else {
        console.log('No user found with email/username:', emailLower);
        // List first 5 users for debugging
        const sampleUsers = await db.User.findAll({
          limit: 5,
          attributes: ['id', 'email', 'username', 'role']
        });
        console.log('Sample users in database:', sampleUsers.map(u => ({ email: u.email, username: u.username, role: u.role })));
      }
    } catch (dbError) {
      console.error('Database error finding user:', dbError);
      console.error('Error stack:', dbError.stack);
      return res.status(500).json({
        success: false,
        message: 'Database error. Please try again.',
        error: process.env.NODE_ENV === 'development' ? dbError.message : undefined
      });
    }

    if (!user) {
      console.log('User not found');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    console.log('User found:', user.email, 'Active:', user.is_active);

    // Check if user is active
    if (!user.is_active) {
      console.log('User is inactive');
      return res.status(401).json({
        success: false,
        message: 'Account is inactive. Please contact administrator.'
      });
    }

    // Verify password
    if (!user.password) {
      console.log('User has no password');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    console.log('Comparing password...');
    let isPasswordValid = false;
    try {
      isPasswordValid = await bcrypt.compare(password, user.password);
      console.log('Password match:', isPasswordValid);
    } catch (bcryptError) {
      console.error('Bcrypt error:', bcryptError);
      console.error('Bcrypt stack:', bcryptError.stack);
      return res.status(500).json({
        success: false,
        message: 'Password verification failed',
        error: process.env.NODE_ENV === 'development' ? bcryptError.message : undefined
      });
    }

    if (!isPasswordValid) {
      console.log('Password mismatch');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    console.log('Generating token...');
    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
    console.log('Token generated');

    // Get branch separately if needed
    let branch = null;
    if (user.branch_id) {
      try {
        branch = await db.Branch.findByPk(user.branch_id, {
          attributes: ['id', 'name', 'code']
        });
        console.log('Branch found:', branch ? 'Yes' : 'No');
      } catch (err) {
        console.warn('Could not fetch branch:', err.message);
      }
    }

    console.log('Login successful for:', user.email);
    const responseData = {
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          username: user.username,
          role: user.role,
          branch_id: user.branch_id,
          branch: branch
        },
        token
      }
    };
    
    console.log('Sending response:', JSON.stringify(responseData, null, 2));
    res.json(responseData);
  } catch (error) {
    console.error('=== LOGIN ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred during login',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await db.User.findByPk(req.userId, {
      include: [{ model: db.Branch, as: 'branch' }],
      attributes: { exclude: ['password'] }
    });

    res.json({
      success: true,
      data: { user }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get user',
      error: error.message
    });
  }
});

// Logout (client-side token removal)
router.post('/logout', authenticate, (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

module.exports = router;
