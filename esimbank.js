// Bank-transfer payments for the eSIM bot, verified against real TDB deposit emails.
//
// Flow:
//  - When a customer picks a plan, createBankOrder() gives them a unique 5-digit code (e.g. 12345)
//    to write in the transfer note.
//  - The Gmail Apps Script posts each real TDB deposit to /webhook/bank   -> onDeposit
//  - The customer sends a screenshot of the transfer                      -> handleScreenshot
//  - Claude reads the screenshot (amount, time, account, note). The eSIM is only sent if a
//    real, unclaimed deposit with the same amount arrived at about the same time.
//  - If the bank email is late, the order waits and is completed as soon as the deposit arrives.
//
// Everything is stored in your existing Postgres. The tables are created automatically.

const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const db = require("./db");
const msg = require("./messenger");

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
// TDB shows the same account in two formats, so either number is accepted.
const ACCOUNT_DIGITS = (process.env.RECEIPT_ACCOUNT_DIGITS || "416075929,4003312175")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OWNER_PSID = process.env.OWNER_PSID || ""; // optional: your own Messenger ID for alerts

const MIN = 60 * 1000;
const TOLERANCE_MS = Number(process.env.TIME_TOLERANCE_MIN || 10) * MIN; // receipt time vs email time
const MAX_RECEIPT_AGE_MS = Number(process.env.MAX_RECEIPT_AGE_MIN || 60) * MIN; // reject old screenshots
const WAIT_MINUTES = 60; // how long an order waits for its bank email

let provision = null; // async (senderId, plan, transactionKey) => sends the eSIM
let ready = Promise.resolve();

async function ensureTables() {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS bank_deposits (
      id TEXT PRIMARY KEY,
      amount BIGINT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      claimed_by_order TEXT,
      claimed_at TIMESTAMPTZ
    )
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS bank_orders (
      code TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      plan_id BIGINT NOT NULL,
      amount BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      receipt_at TIMESTAMPTZ,
      waiting_since TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      deposit_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function init(ctx) {
  provision = ctx.provision;
  ready = ensureTables();
  ready.catch((e) => console.error("[bank] table setup failed:", e.message));
}

// ---------- order codes ----------

// Called from flow.js when the customer picks a plan. Returns e.g. "48213".
async function createBankOrder(senderId, plan) {
  await ready;
  const amount = Math.round(Number(plan.price_mnt));
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000)); // digits only, e.g. 48213
    const r = await db.pool.query(
      `INSERT INTO bank_orders (code, sender_id, plan_id, amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [code, senderId, plan.id, amount]
    );
    if (r.rows[0]) return code;
  }
  throw new Error("could not allocate an order code");
}

// Every standalone 5-digit number in the note (not part of a longer number such
// as a phone number). One of them should be the customer's order code.
function findCodes(note) {
  return String(note || "").match(/(?<!\d)\d{5}(?!\d)/g) || [];
}

// ---------- screenshot reading (Claude vision) ----------
const RECEIPT_PROMPT = `This image may be a screenshot of a Mongolian bank app showing a money transfer result.
Return ONLY a JSON object, nothing else:
{"is_bank_receipt": boolean, "success": boolean, "amount_mnt": number or null, "datetime": "YYYY-MM-DD HH:mm" or null, "recipient_account": string or null, "transaction_note": string or null}
- is_bank_receipt: true only if it clearly is a bank transfer result screen.
- success: true only if it says the transaction was successful (Гүйлгээ амжилттай).
- amount_mnt: the transferred amount as a plain number (12,000.00 MNT -> 12000).
- datetime: the date and time printed on the screen.
- recipient_account: the receiving account number / IBAN exactly as printed (Хүлээн авагч).
- transaction_note: the transaction note / reference text (Гүйлгээний утга) exactly as printed.`;

async function extractReceipt(imageUrl) {
  const resp = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxContentLength: 10 * 1024 * 1024,
  });
  let mediaType = String(resp.headers["content-type"] || "image/jpeg").split(";")[0];
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) mediaType = "image/jpeg";

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(resp.data).toString("base64") } },
          { type: "text", text: RECEIPT_PROMPT },
        ],
      },
    ],
  });
  const text = r.content.find((b) => b.type === "text")?.text || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    console.error(
      "[bank] vision reply had no JSON. stop_reason:",
      r.stop_reason,
      "blocks:",
      r.content.map((b) => b.type).join(","),
      "text:",
      text.slice(0, 500)
    );
    throw new Error("No JSON in vision reply");
  }
  return JSON.parse(m[0]);
}

// Receipt times are Mongolian local time (UTC+8).
function parseReceiptTime(dt) {
  if (!dt) return null;
  const t = new Date(String(dt).trim().replace(" ", "T") + ":00+08:00").getTime();
  return Number.isNaN(t) ? null : t;
}

// ---------- helpers ----------
const seenMids = new Set();
function seenBefore(mid) {
  if (!mid) return false;
  if (seenMids.has(mid)) return true;
  seenMids.add(mid);
  if (seenMids.size > 500) seenMids.delete(seenMids.values().next().value);
  return false;
}

async function notifyOwner(text) {
  if (!OWNER_PSID) return;
  try {
    await msg.sendText(OWNER_PSID, text);
  } catch (e) {
    console.error("[bank] notifyOwner failed:", e.response?.data || e.message);
  }
}

// Claims the closest unclaimed deposit for a WAITING order and marks the order PAID,
// all in one database transaction so a deposit can never pay two orders.
// If it succeeds, the eSIM is sent. Returns true if the order was paid.
async function tryResolve(code) {
  const client = await db.pool.connect();
  let order = null;
  try {
    await client.query("BEGIN");

    const o = await client.query(
      `SELECT * FROM bank_orders
       WHERE code = $1 AND status = 'WAITING'
         AND waiting_since > now() - interval '${WAIT_MINUTES} minutes'
       FOR UPDATE`,
      [code]
    );
    if (!o.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    order = o.rows[0];

    const ref = order.receipt_at || order.waiting_since;
    const tolSeconds = (order.receipt_at ? TOLERANCE_MS : TOLERANCE_MS * 3) / 1000; // no time on receipt -> looser

    const d = await client.query(
      `UPDATE bank_deposits SET claimed_by_order = $1, claimed_at = now()
       WHERE id = (
         SELECT id FROM bank_deposits
         WHERE claimed_by_order IS NULL AND amount = $2
           AND abs(extract(epoch FROM (received_at - $3::timestamptz))) <= $4::float8
         ORDER BY abs(extract(epoch FROM (received_at - $3::timestamptz))) ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [code, order.amount, ref, tolSeconds]
    );
    if (!d.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `UPDATE bank_orders SET status = 'PAID', paid_at = now(), deposit_id = $2 WHERE code = $1`,
      [code, d.rows[0].id]
    );
    await client.query("COMMIT");
    console.log(`[bank] ${code} matched deposit ${d.rows[0].id} (${order.amount} MNT)`);
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }

  // Paid -> send the eSIM.
  try {
    const plan = await db.getPlanById(order.plan_id);
    if (!plan) throw new Error(`plan ${order.plan_id} not found`);
    await provision(order.sender_id, plan, `beez_bank_${order.code}`);
  } catch (e) {
    console.error("[bank] delivery failed:", e.response?.data || e.message);
    await notifyOwner(`Bank payment matched but eSIM delivery failed: ${order.code} (${order.amount} MNT).`);
    try {
      await msg.sendText(
        order.sender_id,
        "еСИМ үүсгэхэд алдаа гарлаа. Манай тусламжийн баг тантай удахгүй холбогдоно."
      );
    } catch {}
  }
  return true;
}

// ---------- entry points ----------

// Customer sent an image. Do NOT await this from the Messenger webhook.
async function handleScreenshot({ senderId, imageUrl }) {
  await ready;

  // Only react if this customer asked for a bank transfer recently.
  const { rows: openOrders } = await db.pool.query(
    `SELECT * FROM bank_orders
     WHERE sender_id = $1 AND status IN ('PENDING', 'WAITING')
       AND created_at > now() - interval '48 hours'
     ORDER BY created_at DESC`,
    [senderId]
  );
  if (!openOrders.length) return; // random photo -> ignore

  let receipt;
  try {
    receipt = await extractReceipt(imageUrl);
  } catch (e) {
    console.error("[bank] extractReceipt failed:", e.response?.data || e.message);
    await msg.sendText(senderId, "Зургийг уншиж чадсангүй. Дахин, тод зураг илгээнэ үү.");
    return;
  }

  if (!receipt?.is_bank_receipt || !receipt.success || !Number(receipt.amount_mnt)) {
    await msg.sendText(
      senderId,
      "Гүйлгээний баримтын зургийг (screenshot) илгээнэ үү. Банкны апп дээрх «Гүйлгээ амжилттай» харагдаж байх ёстой."
    );
    return;
  }

  // Receiving account must be ours.
  const recipientDigits = String(receipt.recipient_account || "").replace(/\D/g, "");
  if (recipientDigits && !ACCOUNT_DIGITS.some((a) => recipientDigits.includes(a))) {
    await msg.sendText(senderId, "Баримт дээрх хүлээн авагчийн данс манай данс биш байна. Дансны мэдээллээ шалгана уу.");
    return;
  }

  // Receipt must be recent (stops reuse of old screenshots).
  const receiptAt = parseReceiptTime(receipt.datetime);
  const now = Date.now();
  if (receiptAt && (now - receiptAt > MAX_RECEIPT_AGE_MS || receiptAt - now > TOLERANCE_MS)) {
    await msg.sendText(senderId, "Энэ баримт хуучин эсвэл цаг нь таарахгүй байна. Саяхан хийсэн гүйлгээний баримтыг илгээнэ үү.");
    return;
  }

  // Which order? Prefer the code written in the transfer note, otherwise match by amount.
  const amount = Number(receipt.amount_mnt);
  const noteCodes = findCodes(receipt.transaction_note);
  let order = openOrders.find((o) => noteCodes.includes(o.code)) || null;
  if (!order) order = openOrders.find((o) => Number(o.amount) === amount);

  if (!order || Number(order.amount) !== amount) {
    const expected = Number((order || openOrders[0]).amount);
    await msg.sendText(
      senderId,
      `Баримт дээрх дүн (₮${amount.toLocaleString()}) таны сонгосон багцын үнэтэй (₮${expected.toLocaleString()}) таарахгүй байна. Яг үнийн дүнгээр шилжүүлнэ үү.`
    );
    return;
  }

  // Put the order on the waiting list FIRST, so a deposit arriving right now can't be missed.
  await db.pool.query(
    `UPDATE bank_orders SET status = 'WAITING', receipt_at = $2, waiting_since = now()
     WHERE code = $1 AND status IN ('PENDING', 'WAITING')`,
    [order.code, receiptAt ? new Date(receiptAt) : null]
  );

  const paid = await tryResolve(order.code);
  if (!paid) {
    await msg.sendText(
      senderId,
      "Баримтыг хүлээн авлаа. Банкны гүйлгээг шалгаж байна — баталгаажмагц еСИМ-ийг энд автоматаар илгээнэ. 1 цагийн дотор ирэхгүй бол бидэнтэй холбогдоно уу."
    );
    await notifyOwner(`Waiting for deposit: ${amount} MNT, ${order.code}, from ${senderId}.`);
  }
}

// A real bank deposit email arrived (called by /webhook/bank).
async function onDeposit({ id, amount, receivedAt }) {
  await ready;

  const ins = await db.pool.query(
    `INSERT INTO bank_deposits (id, amount, received_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, Math.round(amount), new Date(receivedAt)]
  );
  if (!ins.rows[0]) return; // duplicate post from the Apps Script

  db.pool.query(`DELETE FROM bank_deposits WHERE received_at < now() - interval '14 days'`).catch(() => {});

  const { rows } = await db.pool.query(
    `SELECT code FROM bank_orders
     WHERE status = 'WAITING' AND waiting_since > now() - interval '${WAIT_MINUTES} minutes'
     ORDER BY waiting_since ASC`
  );
  for (const r of rows) {
    try {
      if (await tryResolve(r.code)) break; // one deposit pays one order
    } catch (e) {
      console.error("[bank] resolve waiting failed:", e.message);
    }
  }
}

module.exports = { init, createBankOrder, handleScreenshot, onDeposit, seenBefore };
