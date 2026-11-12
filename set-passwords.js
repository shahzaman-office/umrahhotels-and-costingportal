'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./api/config/db');

async function setPasswords() {
  const users = [
    { u: 'superadmin', p: 'super123' },
    { u: 'admin',      p: 'admin123' },
    { u: 'user',       p: 'user123' }
  ];

  for (const item of users) {
    const hash = await bcrypt.hash(item.p, 10);
    await pool.execute('UPDATE users SET password = ? WHERE username = ?', [hash, item.u]);
    console.log(`Updated ${item.u} -> ${item.p}`);
  }
  process.exit(0);
}
setPasswords();
