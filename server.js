'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { UPLOAD_BASE } = require('./api/middleware/upload');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ─── Static files ─────────────────────────────────────────────────────────────
// Serve uploads (images) as public URLs
app.use('/uploads', express.static(UPLOAD_BASE));

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────
const authRouter   = require('./api/routes/auth');
const usersRouter  = require('./api/routes/users');
const hotelsRouter = require('./api/routes/hotels');
const quotRouter   = require('./api/routes/quotations');
const queriesRouter= require('./api/routes/queries');
const imagesRouter = require('./api/routes/images');
const miscRouter   = require('./api/routes/misc');
const packagesRouter = require('./api/routes/packages');
const { startEmailScheduler } = require('./api/emailScheduler');

app.use('/api/auth',        authRouter);
app.use('/api/users',       usersRouter);
app.use('/api/hotels',      hotelsRouter);
app.use('/api/quotations',  quotRouter);
app.use('/api/queries',     queriesRouter);
app.use('/api/images',      imagesRouter);
app.use('/api/packages',    packagesRouter);
app.use('/api',             miscRouter);   // branches, vendors, transport, settings, logs, etc.

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  startEmailScheduler();
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║   PAK GLOBE UNIFIED PLATFORM  v1.0    ║');
  console.log('  ║   🕌  Pak Globe Travels               ║');
  console.log(`  ║   🌐  http://localhost:${PORT}          ║`);
  console.log(`  ║   🌐  http://127.0.0.1:${PORT}          ║`);
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
});
