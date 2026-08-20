const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "beeztravel_verify";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const GRAPH_URL = "https://graph.facebook.com/v19.0/me/messages";

const MENU_1 = [
  { title: "🇨🇳 Хятад", url: "https://esim.beez.mn/product/china/" },
  { title: "🇰🇷 Солонгос", url: "https://esim.beez.mn/product/korea/" },
  { title: "🇯🇵 Япон", url: "https://esim.beez.mn/product/%d1%8f%d0%bf%d0%be%d0%bd/" },
];

const MENU_2 = [
  { title: "🌏 Бусад орон", url: "https://esim.beez.mn/" },
];

// --- WEBHOOK VERIFICATION ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- RECEIVE MESSAGES ---
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      const senderId = event.sender.id;
      if (event.message || event.postback) {
        await sendGreeting(senderId);
        await sendButtons(senderId, "✈️ Очих улсаа сонгоно уу:", MENU_1);
        await sendButtons(senderId, "🌏 Бусад:", MENU_2);
      }
    }
  }
  res.status(200).send("EVENT_RECEIVED");
});

async function sendGreeting(recipientId) {
  await axios.post(GRAPH_URL, {
    recipient: { id: recipientId },
    message: { text: "Сайн байна уу? 🌏 Та хаашаа аялах вэ?" },
  }, { params: { access_token: PAGE_ACCESS_TOKEN } });
}

async function sendButtons(recipientId, text, items) {
  const buttons = items.map((item) => ({
    type: "web_url",
    url: item.url,
    title: item.title,
    webview_height_ratio: "full",
  }));

  await axios.post(GRAPH_URL, {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: text,
          buttons: buttons,
        },
      },
    },
  }, { params: { access_token: PAGE_ACCESS_TOKEN } });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✈️ Beez Travel eSIM bot running on port ${PORT}`));
