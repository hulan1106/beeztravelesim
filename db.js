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

// A handful of destinations (Australia, Canada, Hong Kong, Indonesia, Laos,
// Malaysia, South Korea, Turkey, United States) carry two slugs for the same
// GB/duration — a base plan and a "_nonhkip"/"_Premium" network variant at a
// higher price. DISTINCT ON + ORDER BY price picks the cheaper one per GB
// tier for the automated quick-reply flow; both rows still live in the table
// if you want to sell the premium variant manually elsewhere.
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

async function getConversation(senderId) {
  const { rows } = await query(`SELECT * FROM conversations WHERE sender_id = $1`, [senderId]);
  return rows[0] || null;
}

async function upsertConversation(senderId, fields) {
  const existing = await getConversation(senderId);
  const merged = { ...(existing || {}), ...fields, sender_id: senderId };
  await query(
    `INSERT INTO conversations
       (sender_id, state, destination, duration_days, plan_id, invoice_id, invoice_number, order_no, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (sender_id) DO UPDATE SET
       state = EXCLUDED.state,
       destination = EXCLUDED.destination,
       duration_days = EXCLUDED.duration_days,
       plan_id = EXCLUDED.plan_id,
       invoice_id = EXCLUDED.invoice_id,
       invoice_number = EXCLUDED.invoice_number,
       order_no = EXCLUDED.order_no,
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
    ]
  );
}

async function getConversationByInvoiceId(invoiceId) {
  const { rows } = await query(`SELECT * FROM conversations WHERE invoice_id = $1`, [
    String(invoiceId),
  ]);
  return rows[0] || null;
}

module.exports = {
  pool,
  getPlansForCountryAndDuration,
  getAvailableDurations,
  getPlanById,
  getConversation,
  upsertConversation,
  getConversationByInvoiceId,
};
