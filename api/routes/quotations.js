'use strict';
const router = require('express').Router();
const pool   = require('../config/db');
const { requireAuth }  = require('../middleware/auth');
const { hasPerm }      = require('../middleware/rbac');
const { v4: uuid }     = require('uuid');

function departmentForQuotation(q) {
  const text = `${q.includes || ''} ${typeof q.options === 'string' ? q.options : JSON.stringify(q.options || '')}`.toLowerCase();
  if (text.includes('visa')) return 'visa';
  if (text.includes('transport')) return 'transport';
  if (text.includes('ticket') || text.includes('flight')) return 'ticket';
  if (text.includes('hotel')) return 'hotel';
  return 'booking';
}

function parseOptions(options) {
  if (!options) return {};
  if (typeof options === 'object') return options;
  try { return JSON.parse(options); } catch (_) { return {}; }
}

function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function minusDays(date, days) {
  const d = new Date(date); d.setDate(d.getDate() - days); d.setHours(9, 0, 0, 0); return d;
}

async function queueDepartmentEmails(q, approver) {
  if (!process.env.RESEND_API_KEY) return { queued:0, reason:'RESEND_API_KEY not configured' };
  const options = parseOptions(q.options);
  const events = [];
  Object.values(options).forEach(option => {
    if (!option || typeof option !== 'object') return;
    (option.flights || []).forEach(flight => { const date = normalizeDate(flight.date || flight.flightDate); if (date) events.push({ dept:'ticket', date, leadDays:1, label:'flight' }); });
    (option.transports || []).forEach(transport => { const date = normalizeDate(transport.date || transport.transportDate || transport.pickupDate); if (date) events.push({ dept:'transport', date, leadDays:2, label:'transport' }); });
  });
  const uniqueEvents = [...new Map(events.map(event => [`${event.dept}-${event.date.toISOString().slice(0,10)}`, event])).values()];
  if (!uniqueEvents.length) return { queued:0, reason:'No flight or transport date found in quotation' };
  let queued = 0;
  for (const event of uniqueEvents) {
    const [users] = await pool.execute('SELECT full_name,email FROM users WHERE status="active" AND branch_id=? AND LOWER(department)=? AND email IS NOT NULL', [q.branch_id, event.dept]);
    for (const user of users) {
      const scheduledFor = minusDays(event.date, event.leadDays);
      const subject = `${event.label.toUpperCase()} reminder — ${q.invoice_no} — ${q.client_name}`;
      const html = `<h2>${event.label} reminder</h2><p>The ${event.label} for <b>${q.client_name}</b> is scheduled for <b>${event.date.toLocaleDateString('en-GB')}</b>.</p><p>Quotation: <b>${q.invoice_no}</b><br>Approved by: ${approver.fullName || approver.username}</p>`;
      await pool.execute(`INSERT IGNORE INTO scheduled_emails (id,quotation_id,department,recipient_email,subject,html_body,event_date,scheduled_for) VALUES (?,?,?,?,?,?,?,?)`, [uuid(), q.id, event.dept, user.email, subject, html, event.date.toISOString().slice(0,10), scheduledFor]);
      queued++;
    }
  }
  return { queued, events: uniqueEvents.map(event => ({ department:event.dept, eventDate:event.date.toISOString().slice(0,10), leadDays:event.leadDays })) };
}

function canQuot(action = 'view') {
  return (req, res, next) => {
    if (hasPerm(req.user, 'quotations_pvt', action) || 
        hasPerm(req.user, 'quotations_grp', action) || 
        hasPerm(req.user, 'allquot', action)) {
      return next();
    }
    return res.status(403).json({ error: 'Permission denied' });
  };
}

// GET /api/quotations
router.get('/', requireAuth, canQuot('view'), async (req, res) => {
  try {
    let sql = 'SELECT * FROM quotations WHERE deleted_at IS NULL';
    const params = [];
    const { type, status, search } = req.query;

    // Role-based scope
    const role = req.user.role;
    if (role === 'user') {
      sql += ' AND created_by = ?'; params.push(req.user.userId);
    } else if (role === 'branch_admin') {
      sql += ' AND branch_id = ?'; params.push(req.user.branchId);
    }
    if (req.query.mine === '1' && role !== 'user') {
      sql += ' AND created_by = ?'; params.push(req.user.userId);
    }
    // admin & superadmin see everything

    if (type)   { sql += ' AND type = ?';   params.push(type); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (search) {
      sql += ' AND (client_name LIKE ? OR invoice_no LIKE ? OR contact_no LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quotations/:id
router.get('/:id', requireAuth, canQuot('view'), async (req, res) => {
  try {
    const params = [req.params.id];
    let sql = 'SELECT * FROM quotations WHERE id=? AND deleted_at IS NULL';
    if (req.query.mine === '1') { sql += ' AND created_by=?'; params.push(req.user.userId); }
    sql += ' LIMIT 1';
    const [rows] = await pool.execute(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'Quotation not found' });
    const quotation = rows[0];
    const [globalRows] = await pool.execute(
      'SELECT * FROM settings WHERE scope="global" ORDER BY updated_at DESC, id DESC LIMIT 1'
    );
    let brandSettings = globalRows[0] || {};
    if (quotation.branch_id) {
      const [branchRows] = await pool.execute(
        'SELECT * FROM settings WHERE scope="branch" AND branch_id=? ORDER BY updated_at DESC,id DESC LIMIT 1',
        [quotation.branch_id]
      );
      if (branchRows[0]) {
        Object.keys(branchRows[0]).forEach(key => {
          if (branchRows[0][key] !== null) brandSettings[key] = branchRows[0][key];
        });
      }
    }
    quotation.brand_settings = {
      company_name: brandSettings.company_name,
      tagline: brandSettings.tagline,
      phone: brandSettings.phone,
      email: brandSettings.email,
      address: brandSettings.address,
      license_no: brandSettings.license_no,
      logo_url: brandSettings.logo_url,
      brand_color: brandSettings.brand_color,
      terms_text: brandSettings.terms_text,
      disclaimer_text: brandSettings.disclaimer_text
    };
    res.json(quotation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quotations
router.post('/', requireAuth, canQuot('add'), async (req, res) => {
  try {
    const { type, client_name, contact_no, travel_dates, includes,
            adult_pax, child_pax, infant_pax, options } = req.body;
    if (!type || !client_name) return res.status(400).json({ error: 'type and client_name required' });

    // Auto generate invoice number
    let [settRows] = await pool.execute('SELECT invoice_prefix, invoice_next FROM settings WHERE scope="global" LIMIT 1');
    let updateSql = 'UPDATE settings SET invoice_next = invoice_next + 1 WHERE scope="global"';
    let updateParams = [];

    if (req.user.branchId) {
      const [bSett] = await pool.execute('SELECT invoice_prefix, invoice_next FROM settings WHERE scope="branch" AND branch_id=? LIMIT 1', [req.user.branchId]);
      if (bSett.length) {
        settRows = bSett;
        updateSql = 'UPDATE settings SET invoice_next = invoice_next + 1 WHERE scope="branch" AND branch_id=?';
        updateParams = [req.user.branchId];
      }
    }

    const sett   = settRows[0] || { invoice_prefix: 'PGT', invoice_next: 1 };
    const month  = new Date().toISOString().slice(0,7).replace('-','');
    const num    = String(sett.invoice_next || 1).padStart(4,'0');
    const inv_no = `${sett.invoice_prefix || 'PGT'}-${month}-${num}`;

    // Increment counter
    await pool.execute(updateSql, updateParams);

    let bName = req.body.branch_name || null;
    if (!bName && req.user.branchId) {
      const [brRows] = await pool.execute('SELECT name FROM branches WHERE id = ? LIMIT 1', [req.user.branchId]);
      if (brRows.length) bName = brRows[0].name;
    }

    const id = uuid();
    await pool.execute(
      `INSERT INTO quotations
       (id,invoice_no,type,client_name,contact_no,travel_dates,includes,
        adult_pax,child_pax,infant_pax,options,created_by,branch_id,branch_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, inv_no, type, client_name, contact_no||null, travel_dates||null,
       includes||null, parseInt(adult_pax)||0, parseInt(child_pax)||0,
       parseInt(infant_pax)||0,
       options ? JSON.stringify(options) : null,
       req.user.userId, req.user.branchId||null, bName]
    );

    res.json({ id, invoice_no: inv_no, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/quotations/:id
router.put('/:id', requireAuth, canQuot('edit'), async (req, res) => {
  try {
    const { client_name, contact_no, travel_dates, includes, status,
            adult_pax, child_pax, infant_pax, options, shares } = req.body;
    if (status === 'approved' && !['superadmin','admin','branch_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only branch or head-office admins can approve quotations' });
    }
    const previous = (await pool.execute('SELECT * FROM quotations WHERE id=? LIMIT 1', [req.params.id]))[0][0];
    await pool.execute(
      `UPDATE quotations SET client_name=?,contact_no=?,travel_dates=?,includes=?,
       status=COALESCE(?,status),adult_pax=?,child_pax=?,infant_pax=?,options=?,shares=COALESCE(?,shares) WHERE id=?`,
      [client_name, contact_no||null, travel_dates||null, includes||null,
       status||'pending', parseInt(adult_pax)||0, parseInt(child_pax)||0,
       parseInt(infant_pax)||0,
       options ? JSON.stringify(options) : null,
       shares ? JSON.stringify(shares) : null,
       req.params.id]
    );
    let email = null;
    if (status === 'approved' && previous?.status !== 'approved') {
      await pool.execute('UPDATE quotations SET approved_at=NOW(), approved_by=? WHERE id=?', [req.user.userId, req.params.id]);
      try { email = await queueDepartmentEmails({ ...previous, ...req.body, id:req.params.id }, req.user); } catch (mailError) { email = { queued:0, reason:mailError.message }; }
    }
    res.json({ ok:true, email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/quotations/:id  (soft - 30-day recovery)
router.delete('/:id', requireAuth, canQuot('del'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM quotations WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const q = rows[0];

    await pool.execute('UPDATE quotations SET deleted_at=NOW() WHERE id=?', [req.params.id]);

    const exp = new Date(Date.now() + 30 * 86400 * 1000);
    await pool.execute(
      `INSERT INTO recycle_bin (id,entity_type,entity_id,entity_name,data_snapshot,deleted_by,branch_id,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuid(),'quotation',q.id,`${q.invoice_no} - ${q.client_name}`,
       JSON.stringify(q), req.user.userId, req.user.branchId||null, exp]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
