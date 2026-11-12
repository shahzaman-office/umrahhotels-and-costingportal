'use strict';
const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const pool     = require('../config/db');
const { createSession, destroySession } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE username = ? AND status = "active" LIMIT 1',
      [username.toLowerCase().trim()]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Invalid username or password' });

    const user = rows[0];
    const ok   = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(401).json({ error: 'Invalid username or password' });

    const token = await createSession(user);

    // Fetch branch info if branch user
    let branch = null;
    if (user.branch_id) {
      const [br] = await pool.execute('SELECT * FROM branches WHERE id = ? LIMIT 1', [user.branch_id]);
      branch = br[0] || null;
    }

    res.json({
      token,
      user: {
        id:          user.id,
        username:    user.username,
        fullName:    user.full_name,
        email:       user.email,
        phone:       user.phone,
        department:  user.department,
        role:        user.role,
        branchId:    user.branch_id,
        permissions: user.permissions,
      },
      branch
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (token) destroySession(token);
  res.json({ ok: true });
});

// GET /api/auth/me
const { requireAuth } = require('../middleware/auth');
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, full_name, email, phone, department, role, branch_id, permissions, status FROM users WHERE id = ? LIMIT 1',
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];

    let branch = null;
    if (u.branch_id) {
      const [br] = await pool.execute('SELECT * FROM branches WHERE id = ? LIMIT 1', [u.branch_id]);
      branch = br[0] || null;
    }

    res.json({ user: { ...u, fullName: u.full_name }, branch });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.length < 6)
      return res.status(400).json({ error: 'Invalid password data' });

    const [rows] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, rows[0].password);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
