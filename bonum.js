const axios = require("axios");

const BONUM_BASE_URL = process.env.BONUM_BASE_URL || "https://apis.bonum.mn";
const BONUM_APP_SECRET = process.env.BONUM_APP_SECRET;
const BONUM_TERMINAL_ID = process.env.BONUM_TERMINAL_ID;
const BONUM_CHECKSUM_KEY = process.env.BONUM_CHECKSUM_KEY;

const TOKEN_MARGIN_SECONDS = 60;

// In-memory token cache — persists for as long as this server process runs,
// same pattern as Bonum's own official SDK.
let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;
let refreshExpiresAt = 0;

function tokenValid() {
  return accessToken && Date.now() / 1000 < tokenExpiresAt;
}

function refreshValid() {
  return refreshToken && Date.now() / 1000 < refreshExpiresAt;
}

function setTokens(data) {
  accessToken = data.accessToken;
  refreshToken = data.refreshToken;
  const now = Date.now() / 1000;
  tokenExpiresAt = now + data.expiresIn - TOKEN_MARGIN_SECONDS;
  refreshExpiresAt = now + data.refreshExpiresIn - TOKEN_MARGIN_SECONDS;
}

async function login() {
  const res = await axios.get(`${BONUM_BASE_URL}/bonum-gateway/ecommerce/auth/create`, {
    headers: {
      Authorization: `AppSecret ${BONUM_APP_SECRET}`,
      "X-TERMINAL-ID": BONUM_TERMINAL_ID,
    },
  });
  setTokens(res.data);
  return accessToken;
}

async function refresh() {
  try {
    const res = await axios.get(`${BONUM_BASE_URL}/bonum-gateway/ecommerce/auth/refresh`, {
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    setTokens(res.data);
    return accessToken;
  } catch (err) {
    return login(); // refresh failed — fall back to a fresh login
  }
}

async function getAccessToken() {
  if (tokenValid()) return accessToken;
  if (refreshValid()) return refresh();
  return login();
}

// Creates a Bonum invoice and returns { invoiceId, followUpLink }.
// followUpLink is the hosted checkout page — send the customer here, same
// role as byl.mn's invoice.url.
async function createInvoice(amountMnt, description, callbackUrl, transactionId) {
  const token = await getAccessToken();
  const res = await axios.post(
    `${BONUM_BASE_URL}/bonum-gateway/ecommerce/invoices`,
    {
      amount: amountMnt,
      callback: callbackUrl,
      transactionId,
      items: [{ title: description, amount: amountMnt, count: 1, remark: description }],
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return {
    invoiceId: res.data.invoiceId,
    followUpLink: res.data.followUpLink,
  };
}

// Verifies a webhook's x-checksum-v2 header against the raw request body.
// IMPORTANT: must be computed over the raw bytes as received, not a
// re-serialized version of the parsed JSON — key order/spacing can differ.
function verifyWebhookChecksum(rawBody, checksumHeader) {
  if (!checksumHeader) return false;
  const crypto = require("crypto");
  const expected = crypto
    .createHmac("sha256", BONUM_CHECKSUM_KEY)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(checksumHeader));
}

module.exports = { createInvoice, verifyWebhookChecksum };
