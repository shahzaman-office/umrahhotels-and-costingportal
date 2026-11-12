'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

async function check() {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      connectTimeout: 3000
    });
    console.log('STATUS: MYSQL_ONLINE');
    await conn.end();
  } catch (err) {
    console.log('STATUS: MYSQL_ERROR: code=' + err.code + ' msg=' + (err.message || 'none'));
  }
}
check();
