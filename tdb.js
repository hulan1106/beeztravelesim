const axios = require("axios");

const TDB_API_URL = process.env.TDB_API_URL || "https://acsmc.tdbmlabs.mn:8000/order";
const TDB_API_USERNAME = process.env.TDB_API_USERNAME;
const TDB_API_PASSWORD = process.env.TDB_API_PASSWORD;

// Creates a TDB hosted-payment-page order and returns { id, password, hppUrl, fullUrl }.
// fullUrl is what you actually send the customer to — hppUrl + the id/password
// needed to open that specific order (matches the pattern in TDB's own sample code).
async function createOrder(amountMnt, description, redirectUrl) {
  const res = await axios.post(
    TDB_API_URL,
    {
      order: {
        typeRid: "purch",
        amount: amountMnt,
        currency: "MNT",
        description,
        language: "en",
        hppRedirectUrl: redirectUrl,
      },
    },
    {
      auth: {
        username: TDB_API_USERNAME,
        password: TDB_API_PASSWORD,
      },
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    }
  );

  const order = res.data.order;
  const fullUrl = `${order.hppUrl}/?id=${order.id}&password=${order.password}`;

  return {
    id: order.id,
    password: order.password,
    hppUrl: order.hppUrl,
    fullUrl,
  };
}

// Checks an order's current status server-side (PAID/FULLYPAID/AUTHORIZED = success).
async function checkOrderStatus(orderId, orderPassword) {
  const res = await axios.get(`${TDB_API_URL}/${orderId}`, {
    params: { password: orderPassword },
  });
  return res.data;
}

module.exports = { createOrder, checkOrderStatus };
