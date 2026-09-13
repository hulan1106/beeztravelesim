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
      const quickReplyPayload = event.message?.quick_reply?.payload || event.postback?.payload || null;

      // China/Korea/Japan purchase flow (text- or quick-reply-driven, or
      // persistent menu / postback-driven — e.g. the "Дахин эхлэх" menu item)
      try {
        const handled = await flow.handleMessage(senderId, text, quickReplyPayload);
        if (handled) continue;
      } catch (err) {
        console.error("flow error:", err.response?.data || err.message);
        await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
        continue;
      }

      // Anything not recognized by the purchase flow is now simply ignored
      // (fallback menu removed).
    }
  }
  res.status(200).send("EVENT_RECEIVED");
});

// --- SAFARI ESCAPE PAGE (for iPhone users stuck in Messenger's in-app browser) ---
// QPay/bank apps can't open properly inside Facebook Messenger's built-in
// browser on iOS. This page tries an automatic escape trick (x-safari-https://,
// unreliable inside Meta's own apps but harmless to attempt) and — regardless
// of whether that works — always shows clear manual instructions plus a
// direct link, so nobody gets stuck on a blank screen.
app.get("/pay-redirect", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith("http")) {
    return res.status(400).send("Missing or invalid url parameter");
  }

  const safariAttemptUrl = "x-safari-" + targetUrl.replace(/^https?:\/\//, "https://");
  const safeTargetUrl = targetUrl.replace(/"/g, "&quot;");
  const safeSafariUrl = safariAttemptUrl.replace(/"/g, "&quot;");

  res.status(200).send(`<!DOCTYPE html>
<html lang="mn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Төлбөр рүү шилжиж байна...</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #fff7fa; margin: 0; padding: 24px 16px; color: #101018; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #ffd0dd; border-radius: 16px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.6; color: #444; }
  .steps { background: #fafafa; border: 1px solid #eee; border-radius: 12px; padding: 16px; margin: 16px 0; }
  .steps ol { margin: 0; padding-left: 20px; }
  .steps li { margin-bottom: 8px; font-size: 15px; }
  .btn { display: block; text-align: center; background: #f71355; color: #fff; text-decoration: none;
         padding: 14px; border-radius: 10px; font-weight: 700; font-size: 15px; margin-top: 8px; }
  .badge { display: inline-block; background: #fff0f5; border: 1px solid #ffb8cc; border-radius: 999px;
           color: #f71355; font-size: 12px; font-weight: 800; padding: 6px 10px; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">ТӨЛБӨРИЙН ХОЛБООС</div>
    <h1>Төлбөр хийхийн тулд Safari/Chrome ашиглана уу</h1>
    <p>iPhone дээр Messenger-ийн дотоод хөтчөөр банкны апп (QPay гэх мэт) зөв нээгддэггүй тул та доорх алхмуудыг дагана уу:</p>
    <div class="steps">
      <ol>
        <li>Дэлгэцийн дээд буланд байгаа <strong>"•••"</strong> товч дээр дарна уу</li>
        <li><strong>"Нээх Safari-аар"</strong> эсвэл <strong>"Open in Safari/Browser"</strong> сонголтыг дарна уу</li>
        <li>Safari дээр нээгдсэний дараа төлбөрөө хэвийн үргэлжлүүлээрэй</li>
      </ol>
    </div>
    <a class="btn" href="${safeTargetUrl}">Төлбөрийн хуудас руу очих →</a>
  </div>
  <script>
    // Best-effort automatic attempt — silently does nothing if unsupported.
    try {
      window.location.href = "${safeSafariUrl}";
    } catch (e) {}
  </script>
</body>
</html>`);
});

// --- byl.mn PAYMENT WEBHOOK ---
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
    await msg.sendText(convo.sender_id, "Төлбөр хүлээн авлаа ✅ Таны еСИМ-ийг бэлдэж байна...");

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
    await msg.sendButtons(
      convo.sender_id,
      `Таны еСИМ бэлэн боллоо! 🎉\nЗахиалгын дугаар: ${orderNo}\n\nQR кодыг уншуулж, еСИМээ идэвхжүүлээрэй.`,
      [
        { title: "Үлдэгдэл шалгах", url: "https://esim.beez.mn/check-usage/" },
        { title: "Суулгах заавар", url: "https://esim.beez.mn/how-to-install-travel-esim/" },
      ]
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✈️ Beez Travel eSIM bot running on port ${PORT}`));
