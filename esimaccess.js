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

module.exports = { orderEsim, queryEsimProfile };
