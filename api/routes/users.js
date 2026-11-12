'use strict';
const router = require('express').Router();
const pool   = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { can }         = require('../middleware/rbac');
const { v4: uuid }    = require('uuid');
const bcrypt          = require('bcryptjs');

function isBranchAdmin(req) {
  return req.user.role === 'branch_admin';
}

function localRole(role) {
  return ['user', 'editor', 'viewer'].includes(role) ? role : 'user';
}

async function getUserBranch(userId) {
  const [rows] = await pool.execute('SELECT branch_id FROM users WHERE id=? LIMIT 1', [userId]);
  return rows[0] || null;
}

// GET /api/users
router.get('/', requireAuth, can('users'), async (req, res) => {
  try {
    let sql = 'SELECT id,username,full_name,email,phone,department,role,branch_id,status,permissions,last_login,created_at FROM users WHERE 1=1';
    const params = [];

    // Branch admin sees only their branch users
    if (req.user.role === 'branch_admin' && req.user.branchId) {
      sql += ' AND branch_id = ?';
      params.push(req.user.branchId);
    }

    const [rows] = await pool.execute(sql + ' ORDER BY created_at DESC', params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users
router.post('/', requireAuth, can('users','add'), async (req, res) => {
  try {
    const { username, password, full_name, email, phone, department, permissions } = req.body;
    const requestedRole = req.body.role;
    const requestedBranch = req.body.branch_id;
    if (!username || !password || !full_name)
      return res.status(400).json({ error: 'username, password, full_name are required' });

    // Branch admins can create users only inside their own branch.
    const role = isBranchAdmin(req) ? localRole(requestedRole) : (requestedRole || 'user');
    const branch_id = isBranchAdmin(req) ? req.user.branchId : (requestedBranch || null);
    if (isBranchAdmin(req) && !branch_id)
      return res.status(403).json({ error: 'Your account is not linked to a branch' });

    const hash = await bcrypt.hash(password, 10);
    const id   = uuid();
    await pool.execute(
      `INSERT INTO users (id,username,password,full_name,email,phone,department,role,branch_id,permissions)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, username.toLowerCase().trim(), hash, full_name, email||null, phone||null,
       department||null, role||'user', branch_id||null, permissions ? JSON.stringify(permissions) : null]
    );
    res.json({ id, username, full_name, role, branch_id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id
router.put('/:id', requireAuth, can('users','edit'), async (req, res) => {
  try {
    const { full_name, email, phone, department, permissions, status, password } = req.body;
    const target = await getUserBranch(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (isBranchAdmin(req) && target.branch_id !== req.user.branchId)
      return res.status(403).json({ error: 'You can manage users in your branch only' });

    const role = isBranchAdmin(req) ? localRole(req.body.role) : req.body.role;
    const branch_id = isBranchAdmin(req) ? req.user.branchId : (req.body.branch_id || null);
    if (isBranchAdmin(req) && !branch_id)
      return res.status(403).json({ error: 'Your account is not linked to a branch' });
    const fields = ['full_name=?','email=?','phone=?','department=?','role=?','branch_id=?','permissions=?','status=?'];
    const values = [full_name, email||null, phone||null, department||null, role, branch_id||null,
                    permissions ? JSON.stringify(permissions) : null, status||'active'];

    if (password && password.length >= 6) {
      fields.push('password=?');
      values.push(await bcrypt.hash(password, 10));
    }
    values.push(req.params.id);

    await pool.execute(`UPDATE users SET ${fields.join(',')} WHERE id=?`, values);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id  (soft: set inactive)
router.delete('/:id', requireAuth, can('users','del'), async (req, res) => {
  try {
    if (req.params.id === req.user.userId)
      return res.status(400).json({ error: 'Cannot delete your own account' });
    const target = await getUserBranch(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (isBranchAdmin(req) && target.branch_id !== req.user.branchId)
      return res.status(403).json({ error: 'You can manage users in your branch only' });
    await pool.execute('UPDATE users SET status="inactive" WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
