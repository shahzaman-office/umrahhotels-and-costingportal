'use strict';
const mysql  = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host:            process.env.DB_HOST     || 'localhost',
  port:            parseInt(process.env.DB_PORT) || 3306,
  user:            process.env.DB_USER     || 'root',
  password:        process.env.DB_PASS     || '',
  database:        process.env.DB_NAME     || 'pakglobe_unified',
  charset:         'utf8mb4',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit:      0,
  timezone:        '+00:00'
});

// Quick health-check on startup
pool.getConnection()
  .then(conn => { conn.release(); console.log('✅  MySQL pool connected'); })
  .catch(err  => { console.error('❌  MySQL connection failed:', err.message); });

module.exports = pool;
