const axios = require("axios");

const ACCESS_CODE = process.env.ESIMACCESS_ACCESS_CODE;
const BASE = "https://api.esimaccess.com/api/v1/open";

function headers() {
  return {
    "RT-AccessCode": ACCESS_CODE,
    "Content-Type": "application/json",
  };
}

// packageCode = the `slug` column from esim_plans.
// IMPORTANT: do NOT send a price/amount here. An earlier version of this
// code sent a price (first your MNT sell price, then a live-fetched price)
// and eSIM Access rejected both with "200005 the package's price is
// expired." Your working WordPress/WooCommerce integration on the same
// eSIM Access account confirms the correct call omits price/amount
// entirely — eSIM Access charges its own current price automatically.
async function orderEsim({ packageCode, transactionId }) {
  const res = await axios.post(
    `${BASE}/esim/order`,
    {
      transactionId,
      packageInfoList: [{ packageCode, count: 1 }],
    },
    { headers: headers() }
  );
  const body = res.data;
  console.log(`[esimaccess] order response:`, JSON.stringify(body));
  if (body.errorCode) {
    throw new Error(`eSIM Access order failed: ${body.errorCode} ${body.errorMsg || ""} (packageCode=${packageCode})`);
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
};
