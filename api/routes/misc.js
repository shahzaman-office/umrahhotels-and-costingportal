'use strict';
const router = require('express').Router();
const pool   = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { can }         = require('../middleware/rbac');
const { v4: uuid }    = require('uuid');

async function saveBranchQuoteInstructions(executor, branchId, body) {
  const hasTerms = Object.prototype.hasOwnProperty.call(body, 'terms_text');
  const hasDisclaimer = Object.prototype.hasOwnProperty.call(body, 'disclaimer_text');
  if (!hasTerms && !hasDisclaimer) return;

  for (const key of ['terms_text', 'disclaimer_text']) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (body[key] !== null && typeof body[key] !== 'string') {
      throw new Error(`${key} must be a string`);
    }
    if ((body[key] || '').length > 10000) {
      throw new Error(`${key} must be 10000 characters or fewer`);
    }
  }
  const [rows] = await executor.execute(
    'SELECT id FROM settings WHERE scope="branch" AND branch_id=? ORDER BY updated_at DESC,id DESC LIMIT 1',
    [branchId]
  );
  const termsText = hasTerms ? (String(body.terms_text || '').trim() || null) : undefined;
  const disclaimerText = hasDisclaimer ? (String(body.disclaimer_text || '').trim() || null) : undefined;
  if (rows.length) {
    const updates = [];
    const values = [];
    if (hasTerms) { updates.push('terms_text=?'); values.push(termsText); }
    if (hasDisclaimer) { updates.push('disclaimer_text=?'); values.push(disclaimerText); }
    values.push(rows[0].id);
    await executor.execute(`UPDATE settings SET ${updates.join(',')} WHERE id=?`, values);
  } else {
    await executor.execute(
      'INSERT INTO settings (scope,branch_id,terms_text,disclaimer_text) VALUES ("branch",?,?,?)',
      [branchId, hasTerms ? termsText : null, hasDisclaimer ? disclaimerText : null]
    );
  }
}

// ─── BRANCHES ────────────────────────────────────────────────────────────────
// GET /api/branches
router.get('/branches', requireAuth, can('branches'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM branches WHERE status="active" ORDER BY name');
    const [branchSettings] = await pool.execute(
      'SELECT branch_id,logo_url,terms_text,disclaimer_text FROM settings WHERE scope="branch" AND branch_id IS NOT NULL ORDER BY updated_at DESC,id DESC'
    );
    const settingsByBranch = new Map();
    branchSettings.forEach(settings => {
      if (!settingsByBranch.has(settings.branch_id)) settingsByBranch.set(settings.branch_id, settings);
    });
    res.json(rows.map(branch => {
      const settings = settingsByBranch.get(branch.id);
      return {
        ...branch,
        logo_url: settings?.logo_url || branch.logo_url,
        terms_text: settings?.terms_text || '',
        disclaimer_text: settings?.disclaimer_text || ''
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/branches
router.post('/branches', requireAuth, can('branches','add'), async (req, res) => {
  let connection;
  try {
    const { name, code, phone, email, address, license_no, logo_url, brand_color,
            invoice_prefix, default_roe, settings } = req.body;
    const id = uuid();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO branches (id,name,code,phone,email,address,license_no,logo_url,
       brand_color,invoice_prefix,default_roe,settings) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,name,code||null,phone||null,email||null,address||null,license_no||null,
       logo_url||null,brand_color||'#7EC8E3',invoice_prefix||'PGT',
       parseFloat(default_roe)||78,settings?JSON.stringify(settings):null]
    );
    await saveBranchQuoteInstructions(connection, id, req.body || {});
    await connection.commit();
    res.json({ id, name });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackErr) {
        console.error('Branch creation rollback failed:', rollbackErr.message);
      }
    }
    const invalid = /must be a string|must be 10000 characters/.test(err.message);
    res.status(invalid ? 400 : 500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// PUT /api/branches/:id
router.put('/branches/:id', requireAuth, can('branches','edit'), async (req, res) => {
  let connection;
  try {
    if (req.user.role === 'branch_admin' && req.user.branchId !== req.params.id) {
      return res.status(403).json({ error: 'You can only edit your assigned branch' });
    }
    const { name, code, phone, email, address, license_no, logo_url,
            brand_color, invoice_prefix, invoice_next, default_roe, settings, status } = req.body;
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id FROM branches WHERE id=? LIMIT 1', [req.params.id]);
    if (!existing.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Branch not found' });
    }
    await connection.execute(
      `UPDATE branches SET name=?,code=?,phone=?,email=?,address=?,license_no=?,
       logo_url=?,brand_color=?,invoice_prefix=?,invoice_next=?,default_roe=?,settings=?,status=?
       WHERE id=?`,
      [name,code||null,phone||null,email||null,address||null,license_no||null,
       logo_url||null,brand_color||'#7EC8E3',invoice_prefix||'PGT',
       parseInt(invoice_next)||1,parseFloat(default_roe)||78,
       settings?JSON.stringify(settings):null,status||'active',req.params.id]
    );
    await saveBranchQuoteInstructions(connection, req.params.id, req.body || {});
    await connection.commit();
    res.json({ ok: true });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackErr) {
        console.error('Branch update rollback failed:', rollbackErr.message);
      }
    }
    const invalid = /must be a string|must be 10000 characters/.test(err.message);
    res.status(invalid ? 400 : 500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/branches/:id/instructions', requireAuth, async (req, res) => {
  const isBranchManager = req.user.role === 'branch_admin' && req.user.branchId === req.params.id;
  if (!isBranchManager && !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id FROM branches WHERE id=? LIMIT 1', [req.params.id]);
    if (!existing.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Branch not found' });
    }
    await saveBranchQuoteInstructions(connection, req.params.id, req.body || {});
    await connection.commit();
    res.json({ ok: true });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackErr) {
        console.error('Branch instruction update rollback failed:', rollbackErr.message);
      }
    }
    const invalid = /must be a string|must be 10000 characters/.test(err.message);
    res.status(invalid ? 400 : 500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /api/branches/:id
router.delete('/branches/:id', requireAuth, can('branches','del'), async (req, res) => {
  try {
    await pool.execute('UPDATE branches SET status="inactive" WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── VENDORS ──────────────────────────────────────────────────────────────────
router.get('/vendors', requireAuth, can('vendors'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM vendors WHERE status="active" ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors', requireAuth, can('vendors','add'), async (req, res) => {
  try {
    const { name, phone, email, whatsapp, address } = req.body;
    const id = uuid();
    await pool.execute('INSERT INTO vendors (id,name,phone,email,whatsapp,address) VALUES (?,?,?,?,?,?)',
      [id,name,phone||null,email||null,whatsapp||null,address||null]);
    res.json({ id, name });
  } catch (err) {
    if (err.code==='ER_DUP_ENTRY') return res.status(409).json({ error: 'Vendor already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/vendors/:id', requireAuth, can('vendors','edit'), async (req, res) => {
  try {
    const { name, phone, email, whatsapp, address, status } = req.body;
    await pool.execute('UPDATE vendors SET name=?,phone=?,email=?,whatsapp=?,address=?,status=? WHERE id=?',
      [name,phone||null,email||null,whatsapp||null,address||null,status||'active',req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/vendors/:id', requireAuth, can('vendors','del'), async (req, res) => {
  try {
    await pool.execute('UPDATE vendors SET status="inactive" WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TRANSPORT ────────────────────────────────────────────────────────────────
router.get('/transport', requireAuth, can('transport'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM transport WHERE status="active" ORDER BY sector,vehicle');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/transport', requireAuth, can('transport','add'), async (req, res) => {
  try {
    const { sector, vehicle, rate_sar, rate_pkr } = req.body;
    const id = uuid();
    await pool.execute('INSERT INTO transport (id,sector,vehicle,rate_sar,rate_pkr) VALUES (?,?,?,?,?)',
      [id,sector,vehicle,parseFloat(rate_sar)||0,parseFloat(rate_pkr)||0]);
    res.json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/transport/:id', requireAuth, can('transport','edit'), async (req, res) => {
  try {
    const { sector, vehicle, rate_sar, rate_pkr, status } = req.body;
    await pool.execute('UPDATE transport SET sector=?,vehicle=?,rate_sar=?,rate_pkr=?,status=? WHERE id=?',
      [sector,vehicle,parseFloat(rate_sar)||0,parseFloat(rate_pkr)||0,status||'active',req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/transport/:id', requireAuth, can('transport','del'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM transport WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── HOTELS MASTER (for costing dropdowns) ────────────────────────────────────
router.get('/hotels-master', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM hotels_master ORDER BY city, name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
const CATALOG_CATEGORIES = [
  'airlines', 'cabin_classes', 'room_types', 'meal_plans',
  'vehicle_types', 'transport_sectors', 'baggage_allowances'
];
const DEFAULT_CATALOG_OPTIONS = {
  airlines: ['SAUDI AIRLINE', 'PIA', 'AIRBLUE', 'SERENE AIR', 'FLYNAS', 'EMIRATES', 'QATAR AIRWAYS', 'GULF AIR', 'AIR ARABIA', 'SALAMAIR', 'TURKISH AIRLINES', 'KUWAIT AIRWAYS', 'JAZEERA AIRWAYS', 'OMAN AIR', 'OTHER'],
  cabin_classes: ['ECONOMY', 'BUSINESS', 'FIRST'],
  room_types: ['SHARING', 'DOUBLE', 'TRIPLE', 'QUAD', 'QUINT', 'HEXA', 'SUITE', 'FLAT'],
  meal_plans: ['RO', 'BB', 'HB', 'FB', 'Suhoor', 'Iftar'],
  vehicle_types: ['CAR (1-3 PAX)', 'GMC (4-7 PAX)', 'HIACE (8-10 PAX)', 'COASTER (12-18 PAX)', 'BUS (45-50 PAX)', 'AUTO'],
  transport_sectors: ['JED-MAK-MED-JED', 'JED-MAK-JED', 'MED-MAK-JED', 'MAK-MED', 'MED-MAK', 'MAK ZIYARAT', 'MED ZIYARAT', 'TAIF ZIYARAT', 'BADAR ZIYARAT'],
  baggage_allowances: ['1PC', '2PC', '23KG', '30KG', '7KG + 20KG']
};

function parseCatalog(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('Option catalog must be valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Option catalog must be an object');
  }
  if (Object.keys(value).some(category => !CATALOG_CATEGORIES.includes(category))) {
    throw new Error('Option catalog contains an unsupported category');
  }

  const catalog = {};
  CATALOG_CATEGORIES.forEach(category => {
    const values = value[category];
    if (values === undefined) return;
    if (!Array.isArray(values) || values.length > 100 ||
        values.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > 100)) {
      throw new Error(`Invalid options for ${category}; provide up to 100 non-empty values of 100 characters or fewer`);
    }
    const seen = new Set();
    catalog[category] = values.map(item => item.trim()).filter(item => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  return catalog;
}

function mergeCatalog(globalCatalog, branchCatalog) {
  const merged = {};
  CATALOG_CATEGORIES.forEach(category => {
    const sharedValues = Object.prototype.hasOwnProperty.call(globalCatalog, category)
      ? globalCatalog[category]
      : DEFAULT_CATALOG_OPTIONS[category];
    const values = [...sharedValues, ...(branchCatalog[category] || [])];
    const seen = new Set();
    merged[category] = values.filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  return merged;
}

router.get('/branding', requireAuth, async (req, res) => {
  try {
    const [globalRows] = await pool.execute(
      'SELECT company_name,tagline,phone,email,address,license_no,logo_url,brand_color,terms_text,disclaimer_text FROM settings WHERE scope="global" ORDER BY updated_at DESC,id DESC LIMIT 1'
    );
    const settings = { ...(globalRows[0] || {}) };
    if (req.user.branchId) {
      const [branchRows] = await pool.execute(
        'SELECT name,phone,email,address,license_no,logo_url,brand_color FROM branches WHERE id=? AND status="active" LIMIT 1',
        [req.user.branchId]
      );
      if (branchRows[0]) {
        const branch = branchRows[0];
        settings.company_name = branch.name;
        ['phone', 'email', 'address', 'license_no', 'logo_url', 'brand_color'].forEach(key => {
          if (branch[key] !== null) settings[key] = branch[key];
        });
      }
      const [branchSettings] = await pool.execute(
        'SELECT company_name,tagline,phone,email,address,license_no,logo_url,brand_color,terms_text,disclaimer_text FROM settings WHERE scope="branch" AND branch_id=? ORDER BY updated_at DESC,id DESC LIMIT 1',
        [req.user.branchId]
      );
      if (branchSettings[0]) {
        Object.keys(branchSettings[0]).forEach(key => {
          if (branchSettings[0][key] !== null) settings[key] = branchSettings[0][key];
        });
      }
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings', requireAuth, can('settings'), async (req, res) => {
  try {
    const branchId = req.user.branchId;
    const [global] = await pool.execute('SELECT * FROM settings WHERE scope="global" ORDER BY updated_at DESC, id DESC LIMIT 1');
    const globalSettings = global[0] || {};
    const globalCatalog = parseCatalog(globalSettings.catalog_options);
    let merged = { ...globalSettings };
    let branchCatalog = {};

    if (branchId) {
      const [br] = await pool.execute('SELECT * FROM settings WHERE scope="branch" AND branch_id=? LIMIT 1', [branchId]);
      if (br[0]) {
        // Branch settings override global
        const bsett = br[0];
        Object.keys(bsett).forEach(k => { if (bsett[k] !== null) merged[k] = bsett[k]; });
        branchCatalog = parseCatalog(bsett.catalog_options);
      }
    }
    merged.catalog_options = mergeCatalog(globalCatalog, branchCatalog);
    merged.own_catalog_options = branchId ? branchCatalog : globalCatalog;
    merged.global_catalog_options = globalCatalog;
    merged.company_phone = merged.phone || '';
    merged.company_email = merged.email || '';
    merged.company_address = merged.address || '';
    merged.whatsapp_number = merged.whatsapp || '';
    merged.global_markup = merged.global_margin || 0;
    merged.invoice_start = merged.invoice_next || 1;
    res.json(merged);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', requireAuth, can('settings','edit'), async (req, res) => {
  let connection;
  try {
    const isGlobal = req.user.role === 'superadmin';
    if (!isGlobal && !req.user.branchId) {
      return res.status(403).json({ error: 'A branch assignment is required to edit branch settings' });
    }
    const scope    = isGlobal ? 'global' : 'branch';
    const branchId = isGlobal ? null : req.user.branchId;
    const body = req.body || {};
    const fields = {
      company_name: body.company_name,
      tagline: body.tagline,
      phone: body.phone ?? body.company_phone,
      email: body.email ?? body.company_email,
      address: body.address ?? body.company_address,
      whatsapp: body.whatsapp ?? body.whatsapp_number,
      license_no: body.license_no,
      logo_url: body.logo_url,
      global_margin: body.global_margin ?? body.global_markup,
      room_margins: body.room_margins,
      default_roe: body.default_roe,
      default_visa_adult: body.default_visa_adult,
      default_visa_child: body.default_visa_child,
      default_visa_infant: body.default_visa_infant,
      invoice_prefix: body.invoice_prefix,
      invoice_next: body.invoice_next ?? body.invoice_start,
      brand_color: body.brand_color,
      terms_text: body.terms_text,
      disclaimer_text: body.disclaimer_text,
      filter_perms: body.filter_perms,
      city_order: body.city_order,
      default_meal: body.default_meal,
      default_duration: body.default_duration,
      session_timeout: body.session_timeout,
      wa_quote_template: body.wa_quote_template,
      wa_followup_template: body.wa_followup_template
    };
    const numericFields = new Set([
      'global_margin', 'default_roe', 'default_visa_adult', 'default_visa_child',
      'default_visa_infant', 'invoice_next', 'default_duration', 'session_timeout'
    ]);
    const jsonFields = new Set(['room_margins', 'filter_perms', 'catalog_options']);
    const updates = [];
    const values = [];
    Object.entries(fields).forEach(([column, value]) => {
      if (value === undefined) return;
      if (numericFields.has(column)) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric setting: ${column}`);
        value = parsed;
      } else if (jsonFields.has(column)) {
        value = value == null ? null : JSON.stringify(value);
      } else if (value !== null) {
        value = String(value).trim();
      }
      updates.push(`${column}=?`);
      values.push(value);
    });
    if (Object.prototype.hasOwnProperty.call(body, 'catalog_options')) {
      let catalog;
      try { catalog = parseCatalog(body.catalog_options); }
      catch (err) { return res.status(400).json({ error: err.message }); }
      const [globalRows] = isGlobal
        ? [null]
        : await pool.execute('SELECT catalog_options FROM settings WHERE scope="global" ORDER BY updated_at DESC, id DESC LIMIT 1');
      const globalCatalog = isGlobal ? {} : parseCatalog(globalRows[0]?.catalog_options);
      if (!isGlobal) {
        for (const category of CATALOG_CATEGORIES) {
          const ownValues = catalog[category] || [];
          const inherited = new Set((globalCatalog[category] || []).map(value => value.toLowerCase()));
          catalog[category] = ownValues.filter(value => !inherited.has(value.toLowerCase()));
        }
      }
      updates.push('catalog_options=?');
      values.push(JSON.stringify(catalog));
    }
    if (!updates.length) return res.status(400).json({ error: 'No settings were provided' });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [existing] = isGlobal
      ? await connection.execute('SELECT id FROM settings WHERE scope="global" ORDER BY updated_at DESC, id DESC LIMIT 1 FOR UPDATE')
      : await connection.execute('SELECT id FROM settings WHERE scope="branch" AND branch_id=? LIMIT 1 FOR UPDATE', [branchId]);
    if (existing.length) {
      values.push(existing[0].id);
      await connection.execute(`UPDATE settings SET ${updates.join(',')} WHERE id=?`, values);
    } else {
      const columns = ['scope', 'branch_id', ...updates.map(update => update.split('=')[0])];
      const insertValues = [scope, branchId, ...values];
      await connection.execute(
        `INSERT INTO settings (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        insertValues
      );
    }
    await connection.commit();
    res.json({ ok: true });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackErr) {
        console.error('Settings rollback failed:', rollbackErr.message);
      }
    }
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ─── LOGS ─────────────────────────────────────────────────────────────────────
router.get('/logs', requireAuth, can('logs'), async (req, res) => {
  try {
    const { limit = 200, action, user_id } = req.query;
    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    if (action)  { sql += ' AND action LIKE ?';   params.push(`%${action}%`); }
    if (user_id) { sql += ' AND user_id = ?';     params.push(user_id); }
    sql += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)||200}`;
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── RECYCLE BIN ──────────────────────────────────────────────────────────────
router.get('/recycle', requireAuth, can('recycle'), async (req, res) => {
  try {
    let sql = 'SELECT * FROM recycle_bin WHERE expires_at > NOW()';
    const params = [];
    if (req.user.role === 'branch_admin') {
      sql += ' AND branch_id = ?'; params.push(req.user.branchId);
    }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/recycle/:id/restore
router.post('/recycle/:id/restore', requireAuth, can('recycle','edit'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM recycle_bin WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found in recycle bin' });
    const item = rows[0];

    if (item.entity_type === 'hotel') {
      await pool.execute('UPDATE hotels SET deleted_at=NULL WHERE id=?', [item.entity_id]);
    } else if (item.entity_type === 'quotation') {
      await pool.execute('UPDATE quotations SET deleted_at=NULL WHERE id=?', [item.entity_id]);
    }

    await pool.execute('DELETE FROM recycle_bin WHERE id=?', [req.params.id]);
    res.json({ ok: true, entity_type: item.entity_type, entity_id: item.entity_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── BACKUP ───────────────────────────────────────────────────────────────────
router.get('/backup', requireAuth, can('backup'), async (req, res) => {
  try {
    const tables = ['users','branches','hotels','hotel_vendors','vendors','settings',
                    'queries','quotations','transport','hotels_master'];
    const backup = { _version: 1, _created: new Date().toISOString() };

    for (const t of tables) {
      const [rows] = await pool.execute(`SELECT * FROM ${t}`);
      backup[t] = rows;
    }

    res.setHeader('Content-Disposition', `attachment; filename="pakglobe-backup-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, can('dash'), async (req, res) => {
  try {
    const branchFilter = (req.user.role === 'branch_admin') ? req.user.branchId : null;
    const bParam       = branchFilter ? [branchFilter] : [];
    const bWhere       = branchFilter ? ' AND branch_id=?' : '';

    const [[{ hotels }]]     = await pool.execute('SELECT COUNT(*) hotels FROM hotels WHERE deleted_at IS NULL AND status="active"');
    const [[{ quotations }]] = await pool.execute(`SELECT COUNT(*) quotations FROM quotations WHERE deleted_at IS NULL${bWhere}`, bParam);
    const [[{ queries }]]    = await pool.execute(`SELECT COUNT(*) queries FROM queries WHERE status NOT IN ("booked","closed")${bWhere}`, bParam);
    const [[{ branches }]]   = await pool.execute('SELECT COUNT(*) branches FROM branches WHERE status="active"');
    const [[{ vendors }]]    = await pool.execute('SELECT COUNT(*) vendors FROM vendors WHERE status="active"');

    // Cities breakdown
    const [cityStats]  = await pool.execute('SELECT city, COUNT(*) cnt FROM hotels WHERE deleted_at IS NULL AND status="active" GROUP BY city');
    // Quotations by type
    const [quotStats]  = await pool.execute(`SELECT type, COUNT(*) cnt FROM quotations WHERE deleted_at IS NULL${bWhere} GROUP BY type`, bParam);
    // Recent activity
    const [recentLogs] = await pool.execute('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 10');

    res.json({ hotels, quotations, queries, branches, vendors, cityStats, quotStats, recentLogs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
