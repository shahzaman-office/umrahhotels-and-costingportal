'use strict';
const router = require('express').Router();
const pool   = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { can }         = require('../middleware/rbac');
const { v4: uuid }    = require('uuid');

// GET /api/queries
router.get('/', requireAuth, can('queries'), async (req, res) => {
  try {
    let sql = 'SELECT * FROM queries WHERE 1=1';
    const params = [];
    if (req.user.role === 'branch_admin' || req.user.role === 'user') {
      sql += ' AND branch_id = ?'; params.push(req.user.branchId);
    }
    const { status } = req.query;
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/queries
router.post('/', requireAuth, can('queries','add'), async (req, res) => {
  try {
    const { client_name, client_phone, hotel_id, hotel_name, rooms_requested,
            checkin_date, checkout_date, guest_names, notes } = req.body;

    const id       = uuid();
    const ref_code = 'PGT-' + Math.random().toString(36).toUpperCase().slice(2,7);

    await pool.execute(
      `INSERT INTO queries
       (id,ref_code,client_name,client_phone,hotel_id,hotel_name,rooms_requested,
        checkin_date,checkout_date,guest_names,notes,submitted_by,branch_id,workflow_history)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, ref_code, client_name, client_phone||null, hotel_id||null, hotel_name||null,
       rooms_requested ? JSON.stringify(rooms_requested) : null,
       checkin_date||null, checkout_date||null, guest_names||null, notes||null,
       req.user.userId, req.user.branchId||null,
       JSON.stringify([{ ts: Date.now(), user: req.user.username, action: 'Query submitted' }])]
    );
    res.json({ id, ref_code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/queries/:id  — update status / booking ref
router.put('/:id', requireAuth, can('queries','edit'), async (req, res) => {
  try {
    const { status, supplier_confirmed, booking_ref, notes } = req.body;

    // Append to workflow history
    const [rows] = await pool.execute('SELECT workflow_history FROM queries WHERE id=?', [req.params.id]);
    const history = JSON.parse(rows[0]?.workflow_history || '[]');
    history.push({ ts: Date.now(), user: req.user.username, action: `Status → ${status}`, notes });

    await pool.execute(
      `UPDATE queries SET status=?,supplier_confirmed=?,booking_ref=?,notes=?,workflow_history=? WHERE id=?`,
      [status, supplier_confirmed?1:0, booking_ref||null, notes||null,
       JSON.stringify(history), req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/queries/:id/chat  — add chat message
router.post('/:id/chat', requireAuth, can('queries'), async (req, res) => {
  try {
    const { message } = req.body;
    const [rows] = await pool.execute('SELECT workflow_history FROM queries WHERE id=?', [req.params.id]);
    const history = JSON.parse(rows[0]?.workflow_history || '[]');
    history.push({ ts: Date.now(), user: req.user.username, role: req.user.role, message, type: 'chat' });
    await pool.execute('UPDATE queries SET workflow_history=? WHERE id=?',
      [JSON.stringify(history), req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
