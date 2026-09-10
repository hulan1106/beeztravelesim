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
// NOTE on `price`: eSIM Access historically bills in fixed-point units (USD
// x 10,000) rather than raw MNT. Check your first real order against the
// balance deducted in console.esimaccess.com — if it doesn't match plan.price_mnt,
// swap this for the package's actual `price` field from their package-list
// endpoint instead of your MNT sell price.
async function orderEsim({ packageCode, price, transactionId }) {
  const res = await axios.post(
    `${BASE}/esim/order`,
    {
      transactionId,
      amount: price,
      packageInfoList: [{ packageCode, count: 1, price }],
    },
    { headers: headers() }
  );
  const body = res.data;
  if (body.errorCode) {
    throw new Error(`eSIM Access order failed: ${body.errorCode} ${body.errorMsg || ""}`);
  }
  return body.obj?.orderNo || body.orderNo;
}

// Provisioning can take up to ~30s per eSIM Access, so poll a few times.
// Field names (qrCodeUrl/qrCode/ac) can vary slightly by account/API version —
// log `res.data` on your first live run and adjust here if needed.
async function queryEsimProfile(orderNo, { retries = 8, delayMs = 5000 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await axios.post(
      `${BASE}/esim/query`,
      { orderNo, pager: { pageNum: 1, pageSize: 5 } },
      { headers: headers() }
    );
    const list = res.data.obj?.esimList || res.data.obj?.list || [];
    const profile = list[0];
    if (profile && (profile.qrCodeUrl || profile.qrCode)) {
      return {
        iccid: profile.iccid,
        qrCodeUrl: profile.qrCodeUrl || profile.qrCode,
        activationCode: profile.ac || profile.shortUrl,
      };
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null; // still provisioning — caller decides what to tell the customer
}

module.exports = { orderEsim, queryEsimProfile };
