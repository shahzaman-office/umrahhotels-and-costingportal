'use strict';
const router = require('express').Router();
const pool   = require('../config/db');
const { requireAuth }  = require('../middleware/auth');
const { can }          = require('../middleware/rbac');
const { v4: uuid }     = require('uuid');

// GET /api/hotels  — search + filter
router.get('/', requireAuth, can('hotels'), async (req, res) => {
  try {
    const { q, city, area, shuttle, stars, status = 'active', branch_id } = req.query;
    let sql = 'SELECT h.* FROM hotels h WHERE h.deleted_at IS NULL';
    const params = [];

    if (status) { sql += ' AND h.status = ?'; params.push(status); }
    if (city)   { sql += ' AND h.city = ?';   params.push(city.toUpperCase()); }
    if (area)   { sql += ' AND h.area LIKE ?'; params.push(`%${area}%`); }
    if (shuttle !== undefined) { sql += ' AND h.shuttle = ?'; params.push(shuttle === 'true' ? 1 : 0); }
    if (stars)  { sql += ' AND h.stars >= ?'; params.push(parseInt(stars)); }

    if (q) {
      sql += ' AND (h.name LIKE ? OR h.city LIKE ? OR h.area LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    // Branch visibility filter (branch_admin & branch users see only allowed hotels)
    if (req.user.role === 'branch_admin' || req.user.role === 'user' || req.user.role === 'editor') {
      if (req.user.branchId) {
        sql += ` AND (h.branch_visibility IS NULL OR h.branch_visibility = '[]' OR JSON_CONTAINS(h.branch_visibility, ?))`;
        params.push(JSON.stringify(req.user.branchId));
      }
    }

    sql += ' ORDER BY h.name ASC';
    const [hotels] = await pool.execute(sql, params);

    if (hotels.length > 0) {
      const hotelIds = hotels.map(h => h.id);
      const placeholders = hotelIds.map(() => '?').join(',');
      const [vendors] = await pool.query(
        `SELECT * FROM hotel_vendors WHERE hotel_id IN (${placeholders}) AND status='active'`,
        hotelIds
      );

      const vMap = {};
      vendors.forEach(v => {
        if (!vMap[v.hotel_id]) vMap[v.hotel_id] = [];
        vMap[v.hotel_id].push(v);
      });

      hotels.forEach(h => {
        h.vendors = vMap[h.id] || [];
      });
    }

    res.json(hotels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hotels/:id
router.get('/:id', requireAuth, can('hotels'), async (req, res) => {
  try {
    const [hotels] = await pool.execute('SELECT * FROM hotels WHERE id = ? LIMIT 1', [req.params.id]);
    if (!hotels.length) return res.status(404).json({ error: 'Hotel not found' });
    const hotel = hotels[0];
    const [vendors] = await pool.execute('SELECT * FROM hotel_vendors WHERE hotel_id = ? ORDER BY room_type', [hotel.id]);
    hotel.vendors = vendors;
    res.json(hotel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/hotels
router.post('/', requireAuth, can('hotels','add'), async (req, res) => {
  try {
    const {
      name, city, country, area, distance_text, distance_meters, stars, shuttle,
      status = 'active', description, amenities, image_url, location_url, images,
      branch_visibility, vendors: vList = []
    } = req.body;

    if (!name || !city) return res.status(400).json({ error: 'name and city required' });

    const id = uuid();
    const name_norm = name.toUpperCase().replace(/\s+/g, ' ').trim();
    // 8-char dedup key: CITY::first8alphanum
    const dedup_key = city.toUpperCase() + '::' + name_norm.replace(/[^A-Z0-9]/g,'').slice(0,8);

    await pool.execute(
      `INSERT INTO hotels
       (id,name,name_normalized,city,country,area,distance_text,distance_meters,
        stars,shuttle,status,description,amenities,image_url,location_url,images,branch_visibility,
        dedup_key,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, name_norm, city.toUpperCase(), country||'Saudi Arabia', area||null,
       distance_text||null, parseInt(distance_meters)||0,
       parseInt(stars)||0, shuttle?1:0, status,
       description||null, amenities||null, image_url||null, location_url||null,
       images ? JSON.stringify(images) : null,
       branch_visibility ? JSON.stringify(branch_visibility) : null,
       dedup_key, req.user.userId]
    );

    // Insert vendor rows
    for (const v of vList) {
      await _upsertVendor(id, v);
    }

    // Log action
    await _log(req, 'hotel.create', 'hotel', id, { name, city });

    res.json({ id, name, city, dedup_key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/hotels/:id
router.put('/:id', requireAuth, can('hotels','edit'), async (req, res) => {
  try {
    const {
      name, city, country, area, distance_text, distance_meters, stars, shuttle,
      status, description, amenities, image_url, location_url, images, branch_visibility, vendors: vList
    } = req.body;

    const name_norm = (name||'').toUpperCase().replace(/\s+/g,' ').trim();
    const dedup_key = city ? city.toUpperCase() + '::' + name_norm.replace(/[^A-Z0-9]/g,'').slice(0,8) : undefined;

    const fields = [];
    const vals   = [];

    if (name       !== undefined) { fields.push('name=?','name_normalized=?'); vals.push(name, name_norm); }
    if (city       !== undefined) { fields.push('city=?','dedup_key=?'); vals.push(city.toUpperCase(), dedup_key); }
    if (country    !== undefined) { fields.push('country=?');      vals.push(country); }
    if (area       !== undefined) { fields.push('area=?');         vals.push(area); }
    if (distance_text !== undefined) { fields.push('distance_text=?'); vals.push(distance_text); }
    if (distance_meters !== undefined) { fields.push('distance_meters=?'); vals.push(parseInt(distance_meters)||0); }
    if (stars      !== undefined) { fields.push('stars=?');        vals.push(parseInt(stars)||0); }
    if (shuttle    !== undefined) { fields.push('shuttle=?');      vals.push(shuttle?1:0); }
    if (status     !== undefined) { fields.push('status=?');       vals.push(status); }
    if (description !== undefined) { fields.push('description=?'); vals.push(description); }
    if (amenities  !== undefined) { fields.push('amenities=?');    vals.push(amenities); }
    if (image_url  !== undefined) { fields.push('image_url=?');    vals.push(image_url); }
    if (location_url !== undefined) { fields.push('location_url=?'); vals.push(location_url); }
    if (images     !== undefined) { fields.push('images=?');       vals.push(JSON.stringify(images)); }
    if (branch_visibility !== undefined) { fields.push('branch_visibility=?'); vals.push(JSON.stringify(branch_visibility)); }

    if (fields.length) {
      vals.push(req.params.id);
      await pool.execute(`UPDATE hotels SET ${fields.join(',')} WHERE id=?`, vals);
    }

    // Replace vendor list if supplied
    if (Array.isArray(vList)) {
      await pool.execute('DELETE FROM hotel_vendors WHERE hotel_id=?', [req.params.id]);
      for (const v of vList) await _upsertVendor(req.params.id, v);
    }

    await _log(req, 'hotel.update', 'hotel', req.params.id, { name });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/hotels/:id  (soft delete → recycle bin)
router.delete('/:id', requireAuth, can('hotels','del'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM hotels WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Hotel not found' });
    const hotel = rows[0];

    await pool.execute('UPDATE hotels SET deleted_at = NOW() WHERE id=?', [req.params.id]);

    // Add to recycle bin (7-day expiry)
    const expiry = new Date(Date.now() + 7 * 86400 * 1000);
    await pool.execute(
      `INSERT INTO recycle_bin (id,entity_type,entity_id,entity_name,data_snapshot,deleted_by,branch_id,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuid(),'hotel',hotel.id,hotel.name,JSON.stringify(hotel),req.user.userId,req.user.branchId,expiry]
    );

    await _log(req, 'hotel.delete', 'hotel', req.params.id, { name: hotel.name });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Vendor contract routes ───────────────────────────────────────────────────

// POST /api/hotels/:id/vendors
router.post('/:id/vendors', requireAuth, can('hotels','edit'), async (req, res) => {
  try {
    const vid = await _upsertVendor(req.params.id, req.body, true);
    res.json({ id: vid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/hotels/vendors/:vid
router.put('/vendors/:vid', requireAuth, can('hotels','edit'), async (req, res) => {
  try {
    const v = req.body;
    await pool.execute(
      `UPDATE hotel_vendors SET vendor_name=?,room_type=?,meal_plan=?,price_all=?,
       price_weekday=?,price_weekend=?,price_best=?,extra_bed=?,days_type=?,
       checkin_date=?,checkout_date=?,remarks=?,status=? WHERE id=?`,
      [v.vendor_name, v.room_type||'DOUBLE', _normMeal(v.meal_plan),
       parseFloat(v.price_all)||0, parseFloat(v.price_weekday)||0,
       parseFloat(v.price_weekend)||0, parseFloat(v.price_best)||0,
       parseFloat(v.extra_bed)||0, v.days_type||'ALL',
       v.checkin_date||null, v.checkout_date||null,
       v.remarks||null, v.status||'active', req.params.vid]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/hotels/vendors/:vid
router.delete('/vendors/:vid', requireAuth, can('hotels','edit'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM hotel_vendors WHERE id=?', [req.params.vid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hotels/bulk-import - Batch 19-Column Hotel & Rates Importer
router.post('/bulk-import', requireAuth, can('hotels','add'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { items = [] } = req.body;
    let hAdd = 0, hUpd = 0, rowAdd = 0, dupSkip = 0, vAdd = 0;
    const errs = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.name || !it.city) {
        errs.push({ row: i + 2, msg: 'Missing hotel name or city' });
        continue;
      }
      const normName = it.name.trim().toUpperCase();
      const normCity = it.city.trim().toLowerCase();
      const normArea = (it.area || '').trim().toUpperCase();

      // Find existing hotel
      let [existing] = await conn.execute(
        `SELECT id, name FROM hotels WHERE UPPER(TRIM(name))=? AND LOWER(TRIM(city))=? AND deleted_at IS NULL LIMIT 1`,
        [normName, normCity]
      );

      let hotelId;
      if (existing.length > 0) {
        hotelId = existing[0].id;
        hUpd++;
      } else {
        hotelId = uuid();
        await conn.execute(
          `INSERT INTO hotels (id, name, city, country, area, distance_str, distance_m, shuttle, stars, branch_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [hotelId, normName, normCity, it.country || 'Saudi Arabia', normArea, it.distance || '',
           parseInt(it.distanceValue) || 0, it.shuttle === 'yes' ? 1 : 0, it.stars || '3',
           req.user.branchId || null, req.user.username]
        );
        hAdd++;
      }

      // Process vendor rate row
      if (it.vendor) {
        const vName = it.vendor.trim().toUpperCase();
        const rType = (it.roomType || 'DOUBLE').trim().toUpperCase();
        const mPlan = _normMeal(it.mealPlan || 'RO');
        const pAll  = parseFloat(it.price) || 0;
        const pWk   = parseFloat(it.weekdayRate) || 0;
        const pWe   = parseFloat(it.weekendRate) || 0;
        const dType = it.days || 'ALL';
        const cIn   = it.checkIn || null;
        const cOut  = it.checkOut || null;

        // Check if identical rate row already exists
        const [dupCheck] = await conn.execute(
          `SELECT id FROM hotel_vendors 
           WHERE hotel_id=? AND UPPER(TRIM(vendor_name))=? AND UPPER(TRIM(room_type))=? 
             AND meal_plan=? AND price_all=? AND IFNULL(checkin_date,'')=IFNULL(?,'') AND IFNULL(checkout_date,'')=IFNULL(?,'') LIMIT 1`,
          [hotelId, vName, rType, mPlan, pAll, cIn, cOut]
        );

        if (dupCheck.length > 0) {
          dupSkip++;
        } else {
          await conn.execute(
            `INSERT INTO hotel_vendors (id, hotel_id, vendor_name, room_type, meal_plan, price_all, price_weekday, price_weekend, price_best, extra_bed, days_type, checkin_date, checkout_date, remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [uuid(), hotelId, vName, rType, mPlan, pAll, pWk, pWe, parseFloat(it.bestRate) || 0,
             parseFloat(it.extraBed) || 0, dType, cIn, cOut, it.remarks || null]
          );
          rowAdd++;
        }
      }
    }

    await conn.commit();
    await _log(req, 'Excel Bulk Import', 'hotels', null, { hAdd, hUpd, rowAdd, dupSkip, totalProcessed: items.length });
    res.json({ ok: true, hAdd, hUpd, rowAdd, dupSkip, vAdd, errs });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/hotels/merge - 8-Character Deduplication Merge Engine
router.post('/merge', requireAuth, can('hotels','del'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { keeperId, duplicateIds = [] } = req.body;
    if (!keeperId || !duplicateIds.length) {
      return res.status(400).json({ error: 'keeperId and duplicateIds array are required' });
    }

    await conn.beginTransaction();

    // Verify keeper
    const [keepers] = await conn.execute('SELECT * FROM hotels WHERE id=? AND deleted_at IS NULL', [keeperId]);
    if (!keepers.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Keeper hotel not found' });
    }
    const keeper = keepers[0];

    let totalMovedRates = 0;
    const mergedHotels = [];

    for (const dupId of duplicateIds) {
      if (dupId === keeperId) continue;
      const [dups] = await conn.execute('SELECT * FROM hotels WHERE id=? AND deleted_at IS NULL', [dupId]);
      if (!dups.length) continue;
      const dup = dups[0];

      // Reassign rate rows to keeper
      const [moveRes] = await conn.execute(
        'UPDATE hotel_vendors SET hotel_id=? WHERE hotel_id=?',
        [keeperId, dupId]
      );
      totalMovedRates += moveRes.affectedRows || 0;

      // Soft delete duplicate
      await conn.execute('UPDATE hotels SET deleted_at=NOW() WHERE id=?', [dupId]);

      // Add to recycle bin
      await conn.execute(
        `INSERT INTO recycle_bin (id, entity_type, entity_id, entity_name, data_snapshot, deleted_by)
         VALUES (?, 'hotel', ?, ?, ?, ?)`,
        [uuid(), dupId, dup.name, JSON.stringify(dup), req.user.username]
      );

      mergedHotels.push(dup.name);
    }

    await conn.commit();
    await _log(req, 'Merge Duplicates', 'hotels', keeperId, {
      keeperName: keeper.name,
      mergedCount: mergedHotels.length,
      mergedHotels,
      movedRates: totalMovedRates
    });

    res.json({
      ok: true,
      keeperName: keeper.name,
      mergedCount: mergedHotels.length,
      movedRates: totalMovedRates
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function _upsertVendor(hotelId, v, returnId = false) {
  const id = uuid();
  await pool.execute(
    `INSERT INTO hotel_vendors
     (id,hotel_id,vendor_name,room_type,meal_plan,price_all,price_weekday,price_weekend,
      price_best,extra_bed,days_type,checkin_date,checkout_date,remarks,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, hotelId, v.vendor_name||'', v.room_type||'DOUBLE', _normMeal(v.meal_plan),
     parseFloat(v.price_all)||0, parseFloat(v.price_weekday)||0,
     parseFloat(v.price_weekend)||0, parseFloat(v.price_best)||0,
     parseFloat(v.extra_bed)||0, v.days_type||'ALL',
     v.checkin_date||null, v.checkout_date||null,
     v.remarks||null, v.status||'active']
  );
  return returnId ? id : null;
}

function _normMeal(s = '') {
  const u = s.toUpperCase().replace(/[\.\s_&\/-]/g,'');
  if(u==='RO'||u==='ROOMONLY') return 'RO';
  if(u==='BB'||u==='BEDBREAKFAST'||u==='BREAKFAST') return 'BB';
  if(u==='HB'||u==='HALFBOARD') return 'HB';
  if(u==='FB'||u==='FULLBOARD') return 'FB';
  if(u==='SUHOOR'||u==='SEHRI'||u==='SAHOOR') return 'Suhoor';
  if(u==='IFTAR'||u==='IFTARI') return 'Iftar';
  return s.trim() || 'RO';
}

async function _log(req, action, entity_type, entity_id, details) {
  try {
    await pool.execute(
      `INSERT INTO audit_logs (user_id,username,action,entity_type,entity_id,details,ip_address)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.userId, req.user.username, action, entity_type, entity_id,
       JSON.stringify(details), req.ip]
    );
  } catch(_) { /* non-critical */ }
}

module.exports = router;
