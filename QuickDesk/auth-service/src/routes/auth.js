const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const config = require('../config');
const { authenticate, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
const ROLES = ['user', 'agent', 'admin'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  createdAt: row.created_at,
});

router.get('/health', (req, res) => res.json({ service: 'auth-service', status: 'ok' }));

// Public sign-up. Everyone starts as a plain "user"; only an admin can promote.
router.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};
  const errors = [];
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) errors.push('name is required (max 100 characters)');
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) errors.push('a valid email is required');
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) errors.push('password must be 8-72 characters');
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), email.trim().toLowerCase(), passwordHash]
    );
    return res.status(201).json({ user: publicUser(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  const user = rows[0];
  const valid = user && (await bcrypt.compare(password, user.password_hash));
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign(
    { role: user.role, name: user.name, email: user.email },
    config.jwtSecret,
    { subject: String(user.id), expiresIn: config.jwtExpiresIn, algorithm: 'HS256' }
  );
  return res.json({ token, tokenType: 'Bearer', expiresIn: config.jwtExpiresIn, user: publicUser(user) });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: publicUser(rows[0]) });
}));

// Admin: list users, optionally filtered by role (e.g. ?role=agent)
router.get('/users', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const { role } = req.query;
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  const { rows } = role
    ? await pool.query('SELECT * FROM users WHERE role = $1 ORDER BY id', [role])
    : await pool.query('SELECT * FROM users ORDER BY id');
  return res.json({ data: rows.map(publicUser) });
}));

// Admin: promote / demote a user. The new role appears in the user's NEXT login token.
router.patch('/users/:id/role', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { role } = req.body || {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid user id' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });

  const { rows } = await pool.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING *', [role, id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: publicUser(rows[0]) });
}));

module.exports = router;
