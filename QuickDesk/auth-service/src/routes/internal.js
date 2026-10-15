// Service-to-service endpoints. NOT reachable through the API gateway
// (the gateway only forwards /auth/*), and protected by a shared secret anyway.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const config = require('../config');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

function requireInternalKey(req, res, next) {
  const provided = Buffer.from(String(req.headers['x-internal-api-key'] || ''));
  const expected = Buffer.from(config.internalApiKey);
  const ok = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!ok) return res.status(401).json({ error: 'Invalid internal API key' });
  return next();
}

// ticket-service uses this to check that an assignee exists and is an agent.
router.get('/users/:id', requireInternalKey, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid user id' });
  const { rows } = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  return res.json(rows[0]);
}));

module.exports = router;
