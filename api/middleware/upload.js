'use strict';
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuid } = require('uuid');

const UPLOAD_BASE = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../../uploads');

// Ensure base dirs exist
['hotels','logos','documents'].forEach(d => {
  const p = path.join(UPLOAD_BASE, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.body.linked_type || req.query.type || 'other';
    let folder = 'hotels';
    if (type === 'logo' || type === 'branch') folder = 'logos';
    else if (type === 'document')             folder = 'documents';
    cb(null, path.join(UPLOAD_BASE, folder));
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const type = req.body.linked_type || req.query.type || 'img';
    const id   = uuid().replace(/-/g,'').slice(0,12);
    const ts   = Date.now();
    // System auto-generated filename: type_uuid_timestamp.ext
    cb(null, `${type}_${id}_${ts}${ext}`);
  }
});

const ALLOWED = ['image/jpeg','image/png','image/webp','image/gif'];

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Invalid file type. Allowed: JPG, PNG, WebP, GIF'));
  }
});

/**
 * Generate a public URL for an uploaded file.
 * req  — Express request (used to build host URL)
 * filePath — absolute disk path
 */
function getPublicUrl(req, filePath) {
  const APP_URL = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const rel = filePath.replace(UPLOAD_BASE, '').replace(/\\/g, '/');
  return `${APP_URL}/uploads${rel}`;
}

module.exports = { upload, getPublicUrl, UPLOAD_BASE };
