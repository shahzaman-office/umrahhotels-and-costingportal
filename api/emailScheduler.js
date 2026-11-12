'use strict';
const pool = require('./config/db');

async function sendDueEmails() {
  if (!process.env.RESEND_API_KEY) return;
  const [jobs] = await pool.execute(`SELECT * FROM scheduled_emails WHERE status='queued' AND scheduled_for <= NOW() ORDER BY scheduled_for ASC LIMIT 25`);
  for (const job of jobs) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || 'Pak Globe <onboarding@resend.dev>', to: [job.recipient_email], subject: job.subject, html: job.html_body })
      });
      if (!response.ok) throw new Error(`Resend error ${response.status}`);
      await pool.execute(`UPDATE scheduled_emails SET status='sent', sent_at=NOW(), error_message=NULL WHERE id=?`, [job.id]);
    } catch (error) {
      await pool.execute(`UPDATE scheduled_emails SET status='failed', error_message=? WHERE id=?`, [String(error.message).slice(0, 500), job.id]);
      console.error('Scheduled email failed:', error.message);
    }
  }
}

function startEmailScheduler() {
  sendDueEmails().catch(error => console.error('Email scheduler:', error.message));
  return setInterval(() => sendDueEmails().catch(error => console.error('Email scheduler:', error.message)), 15 * 60 * 1000);
}

module.exports = { startEmailScheduler, sendDueEmails };
