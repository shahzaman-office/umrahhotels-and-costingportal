'use strict';
const router = require('express').Router();
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { hasPerm } = require('../middleware/rbac');
const { v4: uuid } = require('uuid');

function allowed(req) { return hasPerm(req.user, 'packages', 'view') || hasPerm(req.user, 'quotations_pvt', 'view'); }
function scope(sql, params, req) {
  if (req.user.role === 'branch_admin' || req.user.role === 'user') { sql += ' AND p.branch_id=?'; params.push(req.user.branchId); }
  return [sql, params];
}

router.get('/', requireAuth, async (req, res) => {
  if (!allowed(req)) return res.status(403).json({ error: 'Permission denied' });
  try {
    let [sql, params] = scope('SELECT p.*, COALESCE(SUM(pp.amount),0) paid_total FROM quotation_packages p LEFT JOIN package_payments pp ON pp.package_id=p.id WHERE 1=1', [], req);
    sql += ' GROUP BY p.id ORDER BY p.created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows.map(row => ({ ...row, received_amount: Number(row.paid_total || row.received_amount || 0), remaining_amount: Math.max(0, Number(row.total_amount || 0) - Number(row.paid_total || row.received_amount || 0)) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  if (!allowed(req)) return res.status(403).json({ error: 'Permission denied' });
  try {
    const [rows] = await pool.execute('SELECT * FROM quotation_packages WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Package not found' });
    const [payments] = await pool.execute('SELECT amount,received_on,method,note FROM package_payments WHERE package_id=? ORDER BY received_on ASC,created_at ASC', [req.params.id]);
    res.json({ ...rows[0], payments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  if (!hasPerm(req.user, 'packages', 'add') && !hasPerm(req.user, 'quotations_pvt', 'add')) return res.status(403).json({ error: 'Permission denied' });
  try {
    const b = req.body || {}; const id = uuid();
    const visa = Number(b.visa_rate||0)*Number(b.visa_qty||0), ticket = Number(b.ticket_rate||0)*Number(b.ticket_qty||0), transport = Number(b.transport_rate||0)*Number(b.transport_qty||0);
    const total = visa + ticket + transport + Number(b.hotel_amount||0) + Number(b.other_amount||0);
    await pool.execute(`INSERT INTO quotation_packages (id,quotation_id,client_name,branch_id,visa_rate,visa_qty,ticket_rate,ticket_qty,transport_rate,transport_qty,hotel_amount,other_amount,total_amount,remaining_amount,notes,details,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id,b.quotation_id||null,b.client_name,b.branch_id||req.user.branchId||null,b.visa_rate||0,b.visa_qty||0,b.ticket_rate||0,b.ticket_qty||0,b.transport_rate||0,b.transport_qty||0,b.hotel_amount||0,b.other_amount||0,total,total,b.notes||null,b.details ? JSON.stringify(b.details) : null,req.user.userId]);
    if (Array.isArray(b.payments)) for (const p of b.payments) if (Number(p.amount)>0) await pool.execute('INSERT INTO package_payments (id,package_id,amount,received_on,method,note,created_by) VALUES (?,?,?,?,?,?,?)',[uuid(),id,p.amount,p.received_on||new Date(),p.method||null,p.note||null,req.user.userId]);
    res.json({ id, total_amount: total, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/payments', requireAuth, async (req, res) => {
  try { const p=req.body||{}; if (!(Number(p.amount)>0)) return res.status(400).json({error:'Amount required'}); await pool.execute('INSERT INTO package_payments (id,package_id,amount,received_on,method,note,created_by) VALUES (?,?,?,?,?,?,?)',[uuid(),req.params.id,p.amount,p.received_on||new Date(),p.method||null,p.note||null,req.user.userId]); res.json({ok:true}); }
  catch(e){res.status(500).json({error:e.message});}
});
module.exports = router;
