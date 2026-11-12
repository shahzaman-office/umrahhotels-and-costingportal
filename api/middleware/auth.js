'use strict';
/**
 * AUTH MIDDLEWARE
 * Verifies session stored in localStorage (sent as Bearer token in header)
 * Falls back to cookie-based session for browser requests
 */

const pool    = require('../config/db');
const bcrypt  = require('bcryptjs');

// ─── Simple in-memory session store ───────────────────────────────────────────
// For production use Redis or a DB table; for local/office use this is fine
const sessions = new Map(); // token → { userId, username, role, branchId, expiresAt }

function generateToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

function sessionExpiresAt() {
  const hours = parseInt(process.env.SESSION_HOURS || '8');
  return Date.now() + hours * 3600 * 1000;
}

// ─── Create session ────────────────────────────────────────────────────────────
async function createSession(user) {
  const token = generateToken();
  sessions.set(token, {
    userId:    user.id,
    username:  user.username,
    fullName:  user.full_name,
    role:      user.role,
    branchId:  user.branch_id || null,
    email:     user.email || '',
    phone:     user.phone || '',
    permissions: user.permissions || null,
    expiresAt: sessionExpiresAt()
  });

  // Update last_login in DB
  await pool.execute(
    'UPDATE users SET last_login = NOW() WHERE id = ?',
    [user.id]
  );

  return token;
}

// ─── Verify session middleware ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const sess = sessions.get(token);
  if (!sess)                      return res.status(401).json({ error: 'Session not found' });
  if (sess.expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  // Renew expiry on activity
  sess.expiresAt = sessionExpiresAt();
  req.user  = sess;
  req.token = token;
  next();
}

// ─── Destroy session ───────────────────────────────────────────────────────────
function destroySession(token) {
  sessions.delete(token);
}

module.exports = { createSession, requireAuth, destroySession };
