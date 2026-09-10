const axios = require("axios");

const ACCESS_CODE = process.env.ESIMACCESS_ACCESS_CODE;
const BASE = "https://api.esimaccess.com/api/v1/open";

function headers() {
  return {
    "RT-AccessCode": ACCESS_CODE,
    "Content-Type": "application/json",
  };
}

// eSIM Access rejects orders that don't use THEIR current wholesale price for
// the package (error 200005 "the package's price is expired") — your MNT
// sell price is not accepted here, it's just what you charge the customer.
// This looks up the live price for one packageCode right before ordering.
// Price is fixed-point (their docs: divide by 10,000 for USD).
async function getCurrentPrice(packageCode) {
  const res = await axios.post(
    `${BASE}/package/list`,
    { locationCode: "", type: "", packageCode, iccid: "" },
    { headers: headers() }
  );
  const body = res.data;
  console.log(`[esimaccess] package/list for ${packageCode}:`, JSON.stringify(body));
  if (body.errorCode) {
    throw new Error(`eSIM Access package lookup failed: ${body.errorCode} ${body.errorMsg || ""}`);
  }
  const pkg = body.obj?.packageList?.[0];
  if (!pkg) throw new Error(`eSIM Access: no package found for code ${packageCode}`);
  return pkg.price; // fixed-point units, pass straight through to orderEsim
}

// packageCode = the `slug` column from esim_plans. `price` must be the
// CURRENT value from getCurrentPrice(packageCode), not your MNT sell price —
// see note above.
async function orderEsim({ packageCode, transactionId }) {
  const price = await getCurrentPrice(packageCode);
  console.log(`[esimaccess] ordering ${packageCode} at price ${price}`);
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
  console.log(`[esimaccess] order response:`, JSON.stringify(body));
  if (body.errorCode) {
    throw new Error(`eSIM Access order failed: ${body.errorCode} ${body.errorMsg || ""} (tried packageCode=${packageCode}, price=${price})`);
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

module.exports = { orderEsim, queryEsimProfile, getCurrentPrice };
