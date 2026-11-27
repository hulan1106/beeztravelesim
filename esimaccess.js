const axios = require("axios");

const ACCESS_CODE = process.env.ESIMACCESS_ACCESS_CODE;
const BASE = "https://api.esimaccess.com/api/v1/open";

function headers() {
  return {
    "RT-AccessCode": ACCESS_CODE,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// DAILY PLANS (2 GB/day and 5 GB/day) — customer chooses the number of days.
//
// Same prices and rules as the website (travelsim plugin):
//   total = days x price per day, minus 10% from 7 days and 15% from 15 days,
//   then rounded UP to the next 1,000 MNT.
//
// Keys are the `destination` values used in flow.js (DESTINATION_TRIGGERS).
// `code`      = eSIM Access package code (sent as packageCode)
// `perDayMnt` = your sell price per day in MNT (cost x 3,600 x 2)
// `fupKbps`   = speed after the daily data is used up
// ---------------------------------------------------------------------------
const DAILY_PLANS = {
  "China mainland": [
    { gb: 2, code: "PBUK9LV51", perDayMnt: 8640,  fupKbps: 384 },
    { gb: 5, code: "P78LXV6UX", perDayMnt: 17280, fupKbps: 384 },
  ],
  "South Korea": [
    { gb: 2, code: "PD97RF0HS", perDayMnt: 11520, fupKbps: 512 },
    { gb: 5, code: "PX9TSB16T", perDayMnt: 28080, fupKbps: 384 },
  ],
  "Japan": [
    { gb: 2, code: "PPWBVT0BF", perDayMnt: 14400, fupKbps: 384 },
    { gb: 5, code: "PFFM6ED75", perDayMnt: 31680, fupKbps: 384 },
  ],
  "Thailand": [
    { gb: 2, code: "P2R7CWSN9", perDayMnt: 11520, fupKbps: 384 },
    { gb: 5, code: "P5FEBX7X4", perDayMnt: 27288, fupKbps: 384 },
  ],
};

const DAILY_MAX_DAYS = 180;

function dailyDiscount(days) {
  if (days >= 15) return 0.15;
  if (days >= 7) return 0.1;
  return 0;
}

// Total price in MNT for a daily plan, rounded UP to the next 1,000.
function dailyTotalMnt(perDayMnt, days) {
  const total = Math.round(perDayMnt * days * (1 - dailyDiscount(days)) * 100) / 100;
  return Math.ceil(total / 1000) * 1000;
}

// Daily plans offered for a destination (empty array if none).
function getDailyPlans(destination) {
  return DAILY_PLANS[destination] || [];
}

// Finds one daily plan by its eSIM Access package code, or null.
function getDailyPlanByCode(code) {
  for (const [destination, plans] of Object.entries(DAILY_PLANS)) {
    const plan = plans.find((p) => p.code === code);
    if (plan) return { destination, ...plan };
  }
  return null;
}

// packageCode = the `slug` column from esim_plans (normal plans) or the
// package code from DAILY_PLANS (daily plans).
// periodNum   = number of days. Only for daily plans — leave it out for normal
//               plans, which have a fixed duration.
// IMPORTANT: do NOT send a price/amount here. An earlier version of this
// code sent a price (first your MNT sell price, then a live-fetched price)
// and eSIM Access rejected both with "200005 the package's price is
// expired." Your working WordPress/WooCommerce integration on the same
// eSIM Access account confirms the correct call omits price/amount
// entirely — eSIM Access charges its own current price automatically.
async function orderEsim({ packageCode, transactionId, periodNum }) {
  const item = { packageCode, count: 1 };
  if (periodNum) item.periodNum = Number(periodNum);

  const res = await axios.post(
    `${BASE}/esim/order`,
    {
      transactionId,
      packageInfoList: [item],
    },
    { headers: headers() }
  );
  const body = res.data;
  console.log(`[esimaccess] order response:`, JSON.stringify(body));
  if (body.errorCode) {
    throw new Error(
      `eSIM Access order failed: ${body.errorCode} ${body.errorMsg || ""} (packageCode=${packageCode}${periodNum ? `, periodNum=${periodNum}` : ""})`
    );
  }
  return body.obj?.orderNo || body.orderNo;
}

// Provisioning can take up to ~30s per eSIM Access, so poll a few times.
// Readiness check and field names (esimStatus, qrCodeUrl, iccid) match your
// working WordPress plugin on the same account.
async function queryEsimProfile(orderNo, { retries = 8, delayMs = 5000 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await axios.post(
      `${BASE}/esim/query`,
      { orderNo, pager: { pageNum: 1, pageSize: 5 } },
      { headers: headers() }
    );
    console.log(`[esimaccess] query response (attempt ${attempt + 1}):`, JSON.stringify(res.data));
    const list = res.data.obj?.esimList || res.data.obj?.list || [];
    const profile = list[0];
    if (profile && profile.esimStatus === "GOT_RESOURCE" && profile.qrCodeUrl) {
      return {
        iccid: profile.iccid,
        qrCodeUrl: profile.qrCodeUrl,
        ac: profile.ac,
      };
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null; // still provisioning — caller decides what to tell the customer
}

// Single, no-retry lookup by order number — used for the "check usage" flow
// where the eSIM is already known to exist, not freshly ordered. Returns the
// full esim record (iccid, status, expiry, usage) or null if not found.
async function queryEsimByOrderNo(orderNo) {
  const res = await axios.post(
    `${BASE}/esim/query`,
    { orderNo, pager: { pageNum: 1, pageSize: 5 } },
    { headers: headers() }
  );
  console.log(`[esimaccess] queryEsimByOrderNo response:`, JSON.stringify(res.data));
  if (!res.data.success) return null;
  const list = res.data.obj?.esimList || res.data.obj?.list || [];
  return list[0] || null;
}

// Fetches available top-up packages for a specific eSIM (by ICCID).
// Returns the raw packageList array from eSIM Access — each entry has
// packageCode, name, volume (bytes), duration, price (raw API currency unit).
async function listTopupPackages(iccid) {
  const res = await axios.post(
    `${BASE}/package/list`,
    { locationCode: "", type: "TOPUP", packageCode: "", iccid },
    { headers: headers() }
  );
  console.log(`[esimaccess] listTopupPackages response:`, JSON.stringify(res.data));
  if (!res.data.success) {
    throw new Error(`eSIM Access package list failed: ${res.data.errorMsg || "Unknown error"}`);
  }
  return res.data.obj?.packageList || [];
}

// Executes a top-up on an existing eSIM. `amount` must be the CURRENT raw
// price from listTopupPackages for this exact packageCode — fetch it fresh
// right before calling this, don't trust a value cached from earlier, since
// eSIM Access rejects stale prices (same lesson as orderEsim above).
async function topupEsim({ iccid, packageCode, transactionId, amount }) {
  const res = await axios.post(
    `${BASE}/esim/topup`,
    { iccid, packageCode, transactionId, amount },
    { headers: headers() }
  );
  const body = res.data;
  console.log(`[esimaccess] topup response:`, JSON.stringify(body));
  if (!body.success) {
    throw new Error(`eSIM Access topup failed: ${body.errorCode || ""} ${body.errorMsg || "Unknown error"}`);
  }
  return body.obj || {};
}

// Converts your website's live API price into an MNT price to charge the
// customer — identical formula to your WordPress top-up plugin, so pricing
// stays consistent between the website and this bot.
function topupPriceToMnt(rawPrice) {
  return Math.ceil(((rawPrice / 10000) * 3600 * 2) / 100) * 100;
}

// Human-readable bytes, matching your WordPress plugin's formatting.
function formatBytes(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(2)} GB`;
  const tb = gb / 1024;
  return `${tb.toFixed(2)} TB`;
}

module.exports = {
  orderEsim,
  queryEsimProfile,
  queryEsimByOrderNo,
  listTopupPackages,
  topupEsim,
  topupPriceToMnt,
  formatBytes,
  // daily plans
  DAILY_MAX_DAYS,
  getDailyPlans,
  getDailyPlanByCode,
  dailyDiscount,
  dailyTotalMnt,
};
