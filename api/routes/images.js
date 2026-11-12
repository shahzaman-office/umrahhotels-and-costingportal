'use strict';
const router = require('express').Router();
const pool   = require('../config/db');
const { requireAuth }  = require('../middleware/auth');
const { can }          = require('../middleware/rbac');
const { upload, getPublicUrl } = require('../middleware/upload');
const { v4: uuid }     = require('uuid');
const fs               = require('fs');

// POST /api/images/upload
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const publicUrl = getPublicUrl(req, req.file.path);
    const id        = uuid();

    await pool.execute(
      `INSERT INTO images (id,filename,original_name,file_path,public_url,file_size,mime_type,linked_to,linked_type,uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, req.file.filename, req.file.originalname, req.file.path, publicUrl,
       req.file.size, req.file.mimetype,
       req.body.linked_to || null, req.body.linked_type || 'other',
       req.user.userId]
    );

    res.json({ id, url: publicUrl, public_url: publicUrl, filename: req.file.filename, size: req.file.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/images
router.get('/', requireAuth, can('images'), async (req, res) => {
  try {
    const { linked_to, linked_type } = req.query;
    let sql = 'SELECT * FROM images WHERE 1=1';
    const params = [];
    if (linked_to)   { sql += ' AND linked_to = ?';   params.push(linked_to); }
    if (linked_type) { sql += ' AND linked_type = ?'; params.push(linked_type); }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/images/:id  — removes file + DB record
router.delete('/:id', requireAuth, can('images','del'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM images WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Image not found' });
    const img = rows[0];

    // Remove from disk
    if (fs.existsSync(img.file_path)) fs.unlinkSync(img.file_path);

    await pool.execute('DELETE FROM images WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
