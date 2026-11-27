const { Pool } = require("pg");

// Railway auto-injects DATABASE_URL into this service once you attach the
// Postgres plugin from the same project.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

function query(text, params) {
  return pool.query(text, params);
}

// --- eSIM plan catalog ---

async function getPlansForCountryAndDuration(destination, durationDays) {
  const { rows } = await query(
    `SELECT DISTINCT ON (gb) id, destination, gb, duration_days, slug, price_mnt
     FROM esim_plans
     WHERE destination = $1 AND duration_days = $2
     ORDER BY gb ASC, price_mnt ASC`,
    [destination, durationDays]
  );
  return rows;
}

async function getAvailableDurations(destination) {
  const { rows } = await query(
    `SELECT DISTINCT duration_days FROM esim_plans WHERE destination = $1 ORDER BY duration_days ASC`,
    [destination]
  );
  return rows.map((r) => r.duration_days);
}

async function getPlanById(id) {
  const { rows } = await query(`SELECT * FROM esim_plans WHERE id = $1`, [id]);
  return rows[0] || null;
}

// --- conversation state ---
//
// Daily plans (2 GB/day, 5 GB/day) are remembered in three extra columns:
//   daily_code      eSIM Access package code of the chosen daily plan
//   daily_days      number of days the customer chose
//   daily_price_mnt total price in MNT
// These columns must exist (run the ALTER TABLE once in Railway Postgres):
//   ALTER TABLE conversations
//     ADD COLUMN IF NOT EXISTS daily_code TEXT,
//     ADD COLUMN IF NOT EXISTS daily_days INTEGER,
//     ADD COLUMN IF NOT EXISTS daily_price_mnt INTEGER;

async function getConversation(senderId) {
  const { rows } = await query(`SELECT * FROM conversations WHERE sender_id = $1`, [senderId]);
  return rows[0] || null;
}

async function upsertConversation(senderId, fields) {
  const existing = await getConversation(senderId);
  const merged = { ...(existing || {}), ...fields, sender_id: senderId };
  await query(
    `INSERT INTO conversations
       (sender_id, state, destination, duration_days, plan_id, invoice_id, invoice_number, order_no, iccid,
        daily_code, daily_days, daily_price_mnt, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (sender_id) DO UPDATE SET
       state = EXCLUDED.state,
       destination = EXCLUDED.destination,
       duration_days = EXCLUDED.duration_days,
       plan_id = EXCLUDED.plan_id,
       invoice_id = EXCLUDED.invoice_id,
       invoice_number = EXCLUDED.invoice_number,
       order_no = EXCLUDED.order_no,
       iccid = EXCLUDED.iccid,
       daily_code = EXCLUDED.daily_code,
       daily_days = EXCLUDED.daily_days,
       daily_price_mnt = EXCLUDED.daily_price_mnt,
       updated_at = now()`,
    [
      senderId,
      merged.state || "IDLE",
      merged.destination || null,
      merged.duration_days || null,
      merged.plan_id || null,
      merged.invoice_id || null,
      merged.invoice_number || null,
      merged.order_no || null,
      merged.iccid || null,
      merged.daily_code || null,
      merged.daily_days || null,
      merged.daily_price_mnt || null,
    ]
  );
}

async function getConversationByInvoiceId(invoiceId) {
  const { rows } = await query(`SELECT * FROM conversations WHERE invoice_id = $1`, [
    String(invoiceId),
  ]);
  return rows[0] || null;
}

// --- top-up orders ---
// Separate from `conversations` since a customer can top up an eSIM from a
// PAST purchase — this table just maps a byl.mn invoice to the top-up
// details needed once payment confirms.

async function createTopupOrder(senderId, invoiceId, invoiceNumber, iccid, orderNo, packageCode, gb) {
  await query(
    `INSERT INTO topup_orders (sender_id, invoice_id, invoice_number, iccid, order_no, package_code, gb, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'AWAITING_PAYMENT')`,
    [senderId, String(invoiceId), invoiceNumber, iccid, orderNo, packageCode, gb]
  );
}

async function getTopupOrderByInvoiceId(invoiceId) {
  const { rows } = await query(`SELECT * FROM topup_orders WHERE invoice_id = $1`, [String(invoiceId)]);
  return rows[0] || null;
}

async function markTopupOrderPaid(invoiceId) {
  await query(`UPDATE topup_orders SET status = 'PAID' WHERE invoice_id = $1`, [String(invoiceId)]);
}

module.exports = {
  pool,
  getPlansForCountryAndDuration,
  getAvailableDurations,
  getPlanById,
  getConversation,
  upsertConversation,
  getConversationByInvoiceId,
  createTopupOrder,
  getTopupOrderByInvoiceId,
  markTopupOrderPaid,
};
