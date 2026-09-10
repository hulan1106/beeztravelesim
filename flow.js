const db = require("./db");
const byl = require("./byl");
const msg = require("./messenger");

// Maps what a customer types to the exact `destination` string in esim_plans
// (must match the xlsx column verbatim). China has multiple listed products —
// "China mainland" is the plain single-country plan; the mainland+HK+Macao
// and mainland+Japan+Korea bundles are separate products, deliberately not
// wired to this trigger. Add more destinations here as you extend the flow.
const DESTINATION_TRIGGERS = {
  "China mainland": ["china", "хятад", "cn", "hyatad", "hytad", "khyatad", "khytad"],
  "South Korea": ["korea", "солонгос", "kr", "solongos"],
  "Japan": ["japan", "япон", "jp", "yapon"],
    "Russia": ["russia", "орос", "oros"],
  "America": ["America", "Америк", "US"],
    "France": ["France", "франц"],
      "Italy": ["italy", "итали"],
};

// Display label used in bot replies — separate from the DB `destination` key
// so "China mainland" can read as "Хятад" to the customer.
const DISPLAY_NAMES = {
  "China mainland": "Хятад",
  "South Korea": "Солонгос",
  "Japan": "Япон",
};

function matchDestination(text) {
  const t = (text || "").trim().toLowerCase();
  for (const [destination, triggers] of Object.entries(DESTINATION_TRIGGERS)) {
    if (triggers.includes(t)) return destination;
  }
  return null;
}

// Returns true if this message was handled by the purchase flow — caller
// should skip the generic menu fallback in that case.
async function handleMessage(senderId, text, payload) {
  const convo = await db.getConversation(senderId);
  const state = convo?.state || "IDLE";

  if (payload && payload.startsWith("PLAN|")) {
    return handlePlanChosen(senderId, Number(payload.split("|")[1]));
  }

  if (state === "AWAITING_DAYS") {
    return handleDaysReply(senderId, convo, text);
  }

  const destination = matchDestination(text);
  if (destination) {
    await db.upsertConversation(senderId, { state: "AWAITING_DAYS", destination });
    await msg.sendText(
      senderId,
      `${DISPLAY_NAMES[destination]} руу хэдэн хоног явах вэ? Тоогоор бичнэ үү (жишээ нь: 7)`
    );
    return true;
  }

  return false; // not part of this flow
}

async function handleDaysReply(senderId, convo, text) {
  const days = parseInt((text || "").trim(), 10);
  if (!Number.isInteger(days) || days <= 0) {
    await msg.sendText(senderId, "Хоногийн тоог зөвхөн тоогоор бичнэ үү, жишээ нь: 7");
    return true;
  }

  const available = await db.getAvailableDurations(convo.destination);
  if (available.length === 0) {
    await msg.sendText(senderId, "Уучлаарай, энэ чиглэлд одоогоор багц алга байна.");
    return true;
  }

  // Smallest available duration stays exact (e.g. 7). Anything above that
  // targets 30 days specifically (not the true max, which can run much
  // higher for some destinations, e.g. 60/90/180). Falls back to the
  // largest available duration if 30 isn't offered for this destination.
  const smallest = available[0];
  const preferredUpsell = available.includes(30)
    ? 30
    : available[available.length - 1];
  const matchedDuration = days <= smallest ? smallest : preferredUpsell;

  const plans = await db.getPlansForCountryAndDuration(convo.destination, matchedDuration);

  if (matchedDuration !== days) {
    await msg.sendText(
      senderId,
      `${days} хоногийн багц алга тул ${matchedDuration} хоногийн багцыг санал болгож байна:`
    );
  }

  await db.upsertConversation(senderId, { state: "AWAITING_PLAN", duration_days: matchedDuration });
  await msg.sendQuickReplies(
    senderId,
    "Дата хэмжээгээ сонгоно уу:",
    plans.map((p) => ({
      title: `${p.gb} GB - ${Number(p.price_mnt).toLocaleString()}₮`,
      payload: `PLAN|${p.id}`,
    }))
  );
  return true;
}

async function handlePlanChosen(senderId, planId) {
  const plan = await db.getPlanById(planId);
  if (!plan) {
    await msg.sendText(senderId, "Уучлаарай, энэ багц олдсонгүй. Дахин оролдоно уу.");
    return true;
  }

  const invoice = await byl.createInvoice(
    plan.price_mnt,
    `Beez eSIM ${DISPLAY_NAMES[plan.destination] || plan.destination} ${plan.gb}GB / ${plan.duration_days} хоног`
  );

  await db.upsertConversation(senderId, {
    state: "AWAITING_PAYMENT",
    plan_id: plan.id,
    invoice_id: String(invoice.id),
    invoice_number: invoice.number,
  });

  await msg.sendButton(
    senderId,
    `${plan.gb} GB / ${plan.duration_days} хоног — ${Number(plan.price_mnt).toLocaleString()}₮. Төлбөрөө төлж есимээ шууд аваарай:`,
    invoice.url,
    "Төлбөр төлөх"
  );
  return true;
}

module.exports = { handleMessage, matchDestination, DISPLAY_NAMES };
