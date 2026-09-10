const express = require("express");
const axios = require("axios");

const db = require("./db");
const esimaccess = require("./esimaccess");
const msg = require("./messenger");
const flow = require("./flow");

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
  { title: "📊 Үлдэгдэл шалгах", url: "https://esim.beez.mn/check-usage/" },
  { title: "➕ Дата нэмэх", url: "https://esim.beez.mn/check-usage/" },
];

// --- FACEBOOK WEBHOOK VERIFICATION (unchanged) ---
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

// --- RECEIVE MESSENGER MESSAGES ---
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry) {
    const pageId = entry.id;
    for (const event of entry.messaging) {
      const senderId = event.sender.id;

      if (senderId === pageId) continue;
      if (event.message && event.message.is_echo) continue;

      const text = event.message?.text || "";
      const quickReplyPayload = event.message?.quick_reply?.payload || null;

      // NEW: China/Korea/Japan purchase flow (text- or quick-reply-driven)
      try {
        const handled = await flow.handleMessage(senderId, text, quickReplyPayload);
        if (handled) continue;
      } catch (err) {
        console.error("flow error:", err.response?.data || err.message);
        await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
        continue;
      }

      // ORIGINAL BEHAVIOR: anything not recognized by the purchase flow falls
      // back to the default menu, exactly as before.
      if (event.message || event.postback) {
        await sendGreeting(senderId);
        await sendButtons(senderId, "✈️ Очих улсаа сонгоно уу:", MENU_1);
        await sendButtons(senderId, "🌏 Бусад үйлчилгээ:", MENU_2);
      }
    }
  }
  res.status(200).send("EVENT_RECEIVED");
});

// --- NEW: byl.mn PAYMENT WEBHOOK ---
// Configure this URL (https://<your-railway-domain>/webhook/byl) as the
// project webhook in the byl.mn dashboard, subscribed to invoice.paid.
app.post("/webhook/byl", async (req, res) => {
  res.status(200).send("OK"); // ack immediately, do the work after

  const event = req.body;
  if (event.type !== "invoice.paid") return;

  const invoice = event.data?.object;
  if (!invoice) return;

  const convo = await db.getConversationByInvoiceId(invoice.id);
  if (!convo) {
    console.warn("No conversation found for paid invoice", invoice.id);
    return;
  }

  const plan = await db.getPlanById(convo.plan_id);
  if (!plan) {
    console.error("Plan missing for conversation", convo.sender_id);
    return;
  }

  try {
    await msg.sendText(convo.sender_id, "Төлбөр хүлээн авлаа ✅ Таны еСИМийг бэлдэж байна...");

    const orderNo = await esimaccess.orderEsim({
      packageCode: plan.slug,
      transactionId: `beez_${invoice.id}_${Date.now()}`,
    });

    await db.upsertConversation(convo.sender_id, { state: "PROVISIONING", order_no: orderNo });

    const profile = await esimaccess.queryEsimProfile(orderNo);
    if (!profile) {
      await msg.sendText(
        convo.sender_id,
        "еСИМ бэлдэгдэж байна, 1-2 минутын дараа дахин шалгаарай эсвэл манай тусламжийн багтай холбогдоно уу."
      );
      return;
    }

    await msg.sendImage(convo.sender_id, profile.qrCodeUrl);
    await msg.sendText(
      convo.sender_id,
      `еСИМ бэлэн боллоо! 🎉\nICCID: ${profile.iccid}\n\nQR кодыг уншуулж, еСИМээ идэвхжүүлээрэй.`
    );
    await db.upsertConversation(convo.sender_id, { state: "DONE" });
  } catch (err) {
    console.error("eSIM provisioning failed:", err.response?.data || err.message);
    await msg.sendText(
      convo.sender_id,
      "еСИМ үүсгэхэд алдаа гарлаа. Манай тусламжийн баг тантай удахгүй холбогдоно."
    );
  }
});

async function sendGreeting(recipientId) {
  await axios.post(
    GRAPH_URL,
    { recipient: { id: recipientId }, message: { text: "Сайн байна уу? 🌏 Та хаашаа аялах вэ?" } },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

async function sendButtons(recipientId, text, items) {
  const buttons = items.map((item) => ({
    type: "web_url",
    url: item.url,
    title: item.title,
    webview_height_ratio: "full",
  }));

  await axios.post(
    GRAPH_URL,
    {
      recipient: { id: recipientId },
      message: { attachment: { type: "template", payload: { template_type: "button", text, buttons } } },
    },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✈️ Beez Travel eSIM bot running on port ${PORT}`));
