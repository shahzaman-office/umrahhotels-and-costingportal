'use strict';

// Safe, repeatable demo seed. All generated records are clearly marked DEMO-
// and are inserted with INSERT IGNORE so existing business data is preserved.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const COUNT = 100;
const DEMO_PASSWORD = 'Demo@2026!';
const baseDate = new Date('2026-12-01T00:00:00Z');
const pad = value => String(value).padStart(3, '0');
const date = days => new Date(baseDate.getTime() + days * 86400000).toISOString().slice(0, 10);
const json = value => JSON.stringify(value);

const branchSeed = [
  ['DEMO-HYD', 'Hyderabad Main Branch', '022-3410001', 'hyderabad'],
  ['DEMO-KHI', 'Karachi Clifton Branch', '021-3410002', 'karachi'],
  ['DEMO-LHE', 'Lahore Gulberg Branch', '042-3410003', 'lahore'],
  ['DEMO-ISB', 'Islamabad Blue Area Branch', '051-3410004', 'islamabad'],
  ['DEMO-RWP', 'Rawalpindi Saddar Branch', '051-3410005', 'rawalpindi'],
  ['DEMO-MUL', 'Multan Cantt Branch', '061-3410006', 'multan'],
  ['DEMO-FSD', 'Faisalabad D Ground Branch', '041-3410007', 'faisalabad'],
  ['DEMO-PES', 'Peshawar University Road Branch', '091-3410008', 'peshawar'],
  ['DEMO-QUE', 'Quetta Jinnah Road Branch', '081-3410009', 'quetta'],
  ['DEMO-DXB', 'Dubai Partner Desk', '+971-4-3410010', 'dubai']
];

async function run() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'pakglobe_unified'
  });
  const credentials = [];
  try {
    const [seedCheck] = await db.execute('SELECT id FROM quotations WHERE invoice_no = "DEMO-Q-001" LIMIT 1');
    if (seedCheck.length) {
      console.log('Demo seed already exists; no duplicate records were added.');
      return;
    }
    await db.beginTransaction();
    const [existingBranches] = await db.execute('SELECT id,code,name FROM branches WHERE code LIKE "DEMO-%"');
    const branchMap = new Map(existingBranches.map(branch => [branch.code, branch.id]));
    for (const [code, name, phone, city] of branchSeed) {
      const id = branchMap.get(code) || uuid(); branchMap.set(code, id);
      await db.execute(`INSERT IGNORE INTO branches (id,name,code,phone,email,address,license_no,brand_color,invoice_prefix,default_roe,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, name, code, phone, `${code.toLowerCase()}@demo.pakglobe.test`, `Demo office, ${city}, Pakistan`, `DEMO-LIC-${code.slice(-3)}`, '#255446', code.replace('DEMO-', 'DG'), 76, 'active']);
    }
    const branchIds = [...branchMap.values()];
    const [adminRows] = await db.execute('SELECT id FROM users WHERE username="superadmin" LIMIT 1');
    const createdBy = adminRows[0]?.id || null;
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const perms = { hotels: ['view', 'add', 'edit'], costing: ['view', 'add', 'edit'], quotations: ['view', 'add', 'edit'], queries: ['view', 'add', 'edit'], vendors: ['view'], transport: ['view'] };

    for (let i = 1; i <= COUNT; i++) {
      const n = pad(i); const username = `demo_user_${n}`; const branchId = branchIds[(i - 1) % branchIds.length];
      const role = i <= 10 ? 'branch_admin' : i <= 20 ? 'editor' : 'user';
      await db.execute(`INSERT IGNORE INTO users (id,username,password,full_name,email,phone,department,role,branch_id,status,permissions) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [uuid(), username, passwordHash, `Demo Staff ${n}`, `${username}@demo.pakglobe.test`, `0300${String(1000000 + i)}`, ['visa', 'ticket', 'transport', 'hotel', 'booking'][i % 5], role, branchId, 'active', json(perms)]);
      credentials.push({ username, password: DEMO_PASSWORD, role, branch: branchSeed[(i - 1) % branchSeed.length][1], email: `${username}@demo.pakglobe.test` });
    }

    const [userRows] = await db.execute('SELECT id,username FROM users WHERE username LIKE "demo_user_%" ORDER BY username');
    const demoUserIds = userRows.map(user => user.id);
    const cities = [['Makkah', 'Ajyad'], ['Makkah', 'Ibrahim Khalil'], ['Madinah', 'Central Area'], ['Jeddah', 'Al Hamra']];
    const hotelIds = [];
    for (let i = 1; i <= COUNT; i++) {
      const n = pad(i); const [city, area] = cities[(i - 1) % cities.length]; const id = uuid(); hotelIds.push(id);
      await db.execute(`INSERT IGNORE INTO hotels (id,name,name_normalized,city,country,area,distance_text,distance_meters,stars,shuttle,status,description,amenities,dedup_key,created_by,branch_visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `DEMO-${city} Grand Hotel ${n}`, `demo-${city.toLowerCase()}-grand-hotel-${n}`, city, 'Saudi Arabia', area, `${150 + i}m from Haram`, 150 + i, 3 + (i % 3), i % 2, 'active', `Demo hotel inventory record ${n} for system testing.`, 'WiFi, Lift, Breakfast, Reception', `DEMO-HOTEL-${n}`, createdBy, json(branchIds.slice(0, 3))]);
      await db.execute(`INSERT IGNORE INTO hotels_master (id,city,name,stars,area) VALUES (?,?,?,?,?)`, [uuid(), city === 'Madinah' ? 'madina' : city.toLowerCase(), `DEMO-${city} Costing Hotel ${n}`, 3 + (i % 3), area]);
      await db.execute(`INSERT IGNORE INTO hotel_vendors (id,hotel_id,vendor_name,room_type,meal_plan,price_all,price_weekday,price_weekend,price_best,checkin_date,checkout_date,remarks,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [uuid(), id, `DEMO Supplier ${n}`, ['DOUBLE', 'TRIPLE', 'QUAD'][i % 3], ['RO', 'BB', 'HB'][i % 3], 300 + i, 300 + i, 350 + i, 280 + i, date(-30), date(365), 'Demo contract for testing', 'active']);
    }

    for (let i = 1; i <= COUNT; i++) {
      const n = pad(i);
      await db.execute(`INSERT IGNORE INTO vendors (id,name,phone,email,whatsapp,address,status) VALUES (?,?,?,?,?,?,?)`, [uuid(), `DEMO Vendor ${n}`, `+966500${String(100000 + i)}`, `vendor${n}@demo.pakglobe.test`, `966500${String(100000 + i)}`, `Demo supplier office ${n}, Saudi Arabia`, 'active']);
      await db.execute(`INSERT IGNORE INTO transport (id,sector,vehicle,rate_sar,rate_pkr,status) VALUES (?,?,?,?,?,?)`, [uuid(), ['JED-MAK', 'MAK-MED', 'MED-JED', 'MAK ZIYARAT'][i % 4], ['CAR (1-3 PAX)', 'GMC (4-7 PAX)', 'HIACE (8-10 PAX)', 'BUS (45-50 PAX)'][i % 4], 450 + i, (450 + i) * 76, 'active']);
    }

    const quotationIds = [];
    for (let i = 1; i <= COUNT; i++) {
      const n = pad(i); const id = uuid(); quotationIds.push(id); const branchId = branchIds[(i - 1) % branchIds.length]; const type = i % 3 === 0 ? 'group' : 'private';
      await db.execute(`INSERT IGNORE INTO quotations (id,invoice_no,type,client_name,contact_no,travel_dates,includes,status,adult_pax,child_pax,infant_pax,options,created_by,branch_id,branch_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `DEMO-Q-${n}`, type, `DEMO Client ${n}`, `0300${String(2000000 + i)}`, `${date(i % 30)} - ${date((i % 30) + 15)}`, 'FLIGHT, HOTEL, VISA, TRANSPORT', ['pending', 'in_process', 'approved'][i % 3], 2 + (i % 5), i % 2, i % 2 === 0 ? 1 : 0, json({ note: `Demo quotation ${n}`, option_a: { ticket_pkr: 135000, visa_sar: 560, roe: 76 } }), demoUserIds[(i - 1) % demoUserIds.length] || createdBy, branchId, branchSeed[(i - 1) % branchSeed.length][1]]);
    }

    for (let i = 1; i <= COUNT; i++) {
      const n = pad(i); const branchId = branchIds[(i - 1) % branchIds.length];
      await db.execute(`INSERT IGNORE INTO queries (id,ref_code,client_name,client_phone,hotel_id,hotel_name,rooms_requested,checkin_date,checkout_date,guest_names,notes,status,submitted_by,branch_id,workflow_history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [uuid(), `DEMO-QR-${n}`, `DEMO Inquiry Client ${n}`, `0300${String(3000000 + i)}`, hotelIds[(i - 1) % hotelIds.length], `DEMO Hotel ${n}`, json({ room_type: 'DOUBLE', qty: 2 + (i % 3) }), date(i % 20), date((i % 20) + 5), `Guest One ${n}, Guest Two ${n}`, 'Demo inquiry generated for workflow testing.', ['new', 'checking_rates', 'quote_sent', 'booked'][i % 4], demoUserIds[(i - 1) % demoUserIds.length] || createdBy, branchId, json([{ status: 'new', at: date(0) }])]);
    }

    for (let i = 1; i <= COUNT; i++) {
      const n = pad(i); const id = uuid(); const branchId = branchIds[(i - 1) % branchIds.length]; const total = 450000 + (i * 1250); const received = Math.round(total * (i % 4 === 0 ? 1 : i % 3 === 0 ? .55 : .3));
      await db.execute(`INSERT IGNORE INTO quotation_packages (id,client_name,branch_id,visa_rate,visa_qty,ticket_rate,ticket_qty,transport_rate,transport_qty,hotel_amount,other_amount,total_amount,received_amount,remaining_amount,notes,details,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `DEMO Package Client ${n}`, branchId, 560, 2 + (i % 4), 135000, 2 + (i % 4), 450, 1, 180000 + i * 100, 12000, total, received, total - received, 'Demo package for payment and printing tests', json({ contact: `0300${String(4000000 + i)}`, adults: 2 + (i % 4), children: i % 2, travel_date: date(i % 20), return_date: date((i % 20) + 15), makkah_hotel: `DEMO Makkah Hotel ${n} · 10 nights`, madinah_hotel: `DEMO Madinah Hotel ${n} · 5 nights`, inclusions: ['Return Air Ticket', 'Umrah Visa', 'Hotels', 'Transport'] }), demoUserIds[(i - 1) % demoUserIds.length] || createdBy]);
      await db.execute(`INSERT IGNORE INTO package_payments (id,package_id,amount,received_on,method,note,created_by) VALUES (?,?,?,?,?,?,?)`, [uuid(), id, Math.round(received * .6), date(-i), i % 2 ? 'Bank Transfer' : 'Cash', `DEMO-ADV-${n}`, demoUserIds[(i - 1) % demoUserIds.length] || createdBy]);
      if (received > 100000) await db.execute(`INSERT IGNORE INTO package_payments (id,package_id,amount,received_on,method,note,created_by) VALUES (?,?,?,?,?,?,?)`, [uuid(), id, received - Math.round(received * .6), date(-Math.max(1, i - 7)), 'Online', `DEMO-INS-${n}`, demoUserIds[(i - 1) % demoUserIds.length] || createdBy]);
    }

    for (let i = 1; i <= COUNT; i++) await db.execute(`INSERT INTO audit_logs (user_id,username,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)`, [demoUserIds[(i - 1) % demoUserIds.length] || createdBy, `demo_user_${pad(((i - 1) % COUNT) + 1)}`, 'demo.seed', 'demo', uuid(), json({ record: i, source: 'seed-demo-data.js' })]);
    await db.commit();

    const credentialText = `# Demo Test Credentials\n\nGenerated: ${new Date().toISOString()}\n\nAll demo accounts use password: **${DEMO_PASSWORD}**\n\n> These are local testing accounts only. Disable or delete them before production.\n\n| Username | Password | Role | Branch | Email |\n|---|---|---|---|---|\n${credentials.map(item => `| ${item.username} | ${item.password} | ${item.role} | ${item.branch} | ${item.email} |`).join('\n')}\n`;
    fs.writeFileSync(path.join(__dirname, 'DEMO_TEST_CREDENTIALS.md'), credentialText, 'utf8');
    console.log(`Demo seed complete: 10 branches, ${COUNT} users, hotels, vendors, transport, queries, quotations and packages.`);
    console.log('Credentials written to DEMO_TEST_CREDENTIALS.md');
  } catch (error) { await db.rollback(); throw error; }
  finally { await db.end(); }
}

run().catch(error => { console.error('Demo seed failed:', error.code || error.message); process.exitCode = 1; });
