const db = require("./db");
const byl = require("./byl");
const msg = require("./messenger");

// Maps what a customer types to the exact `destination` string in esim_plans
// (must match the xlsx column verbatim). China has multiple listed products —
// "China mainland" is the plain single-country plan; the mainland+HK+Macao
// and mainland+Japan+Korea bundles are separate products, deliberately not
// wired to this trigger. Same logic applies to other bundled rows
// (e.g. "USA & Canada", "Australia & New Zealand") — deliberately left out
// so triggers only match the single-country plans.
const DESTINATION_TRIGGERS = {
  "China mainland": ["china", "хятад", "cn", "hyatad", "hytad", "khyatad", "khytad"],
  "South Korea": ["korea", "солонгос", "kr", "solongos"],
  "Japan": ["japan", "япон", "jp", "yapon"],
  "Russia": ["russia", "орос", "ru"],
  "Germany": ["germany", "герман", "de"],
  "United States": ["usa", "america", "америк", "us"],
  "Kazakhstan": ["kazakhstan", "казахстан", "kz"],
  "Thailand": ["thailand", "тайланд", "th"],
  "Turkey": ["turkey", "turkiye", "турк", "tr"],
  "Vietnam": ["vietnam", "вьетнам", "vn"],
  "Canada": ["canada", "канад", "ca"],
  "Qatar": ["qatar", "катар", "qa"],
  "Czech Republic": ["czech", "чех", "cz"],
  "Australia": ["australia", "австрали", "au"],
  "United Arab Emirates": ["uae", "dubai", "дубай", "арабын нэгдсэн эмират"],
  "Georgia": ["georgia", "гүрж", "ge"],
  "Indonesia": ["indonesia", "индонез", "id"],
};

// Display label used in bot replies — separate from the DB `destination` key
// so DB values can read naturally in Mongolian to the customer.
const DISPLAY_NAMES = {
  "China mainland": "Хятад",
  "South Korea": "Солонгос",
  "Japan": "Япон",
  "Russia": "Орос",
  "Germany": "Герман",
  "United States": "Америк",
  "Kazakhstan": "Казахстан",
  "Thailand": "Тайланд",
  "Turkey": "Турк",
  "Vietnam": "Вьетнам",
  "Canada": "Канад",
  "Qatar": "Катар",
  "Czech Republic": "Чех",
  "Australia": "Австрали",
  "United Arab Emirates": "АНЭУ",
  "Georgia": "Гүрж",
  "Indonesia": "Индонез",
};

function matchDestination(text) {
  const t = (text || "").trim().toLowerCase();
  for (const [destination, triggers] of Object.entries(DESTINATION_TRIGGERS)) {
    if (triggers.includes(t)) return destination;
  }
  return null;
}

// Starts (or restarts) the flow for a newly-matched destination. Shared by
// the mid-flow "changed their mind" path and would also work for a fresh
// IDLE-state match, so both call this instead of duplicating the reset.
async function startDestinationFlow(senderId, destination) {
  await db.upsertConversation(senderId, {
    state: "AWAITING_DAYS",
    destination,
    duration_days: null,
    plan_id: null,
    invoice_id: null,
    invoice_number: null,
  });
  await msg.sendText(
    senderId,
    `${DISPLAY_NAMES[destination]} руу хэдэн хоног явах вэ? Тоогоор бичнэ үү (жишээ нь: 7)`
  );
}

// Returns true if this message was handled by the purchase flow — caller
// should skip the generic menu fallback in that case.
async function handleMessage(senderId, text, payload) {
  const convo = await db.getConversation(senderId);
  const state = convo?.state || "IDLE";

  // Global restart — works no matter what step the customer is stuck on.
  const t = (text || "").trim().toLowerCase();
  if (t === "дахин эхлэх" || payload === "RESTART_ESIM") {
    await db.upsertConversation(senderId, {
      state: "IDLE",
      destination: null,
      duration_days: null,
      plan_id: null,
      invoice_id: null,
      invoice_number: null,
    });
    const destinations = Object.values(DISPLAY_NAMES).join(", ");
    await msg.sendText(
      senderId,
      `Дахин эхэллээ 🔄 Аль улс руу явахаа сонгоно уу: ${destinations}`
    );
    return true;
  }

  if (payload && payload.startsWith("PLAN|")) {
    return handlePlanChosen(senderId, Number(payload.split("|")[1]));
  }

  // --- CHANGED: destination match now checked BEFORE the state-specific
  // handlers below, not after. Previously a customer who'd already picked
  // a country (state = AWAITING_DAYS or AWAITING_PLAN) and then typed a
  // *different* country name would never reach matchDestination() at all —
  // handleDaysReply/handlePlanTextReply claimed the message first and just
  // treated "Хятад" as an invalid day-count/GB reply. Checking it first
  // means naming a new destination always wins and restarts the flow,
  // regardless of what step they were previously on.
  const destination = matchDestination(text);
  if (destination) {
    await startDestinationFlow(senderId, destination);
    return true;
  }
  // --- end CHANGED ---

  if (state === "AWAITING_DAYS") {
    return handleDaysReply(senderId, convo, text);
  }

  if (state === "AWAITING_PLAN") {
    return handlePlanTextReply(senderId, convo, text);
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

  // 1-2 days stays at the smallest available tier (e.g. 7). Anything above
  // 2 days targets 30 days specifically (not the true max, which can run
  // much higher for some destinations, e.g. 60/90/180). Falls back to the
  // largest available duration if 30 isn't offered for this destination.
  const smallest = available[0];
  const preferredUpsell = available.includes(30)
    ? 30
    : available[available.length - 1];
  const matchedDuration = days <= 2 ? smallest : preferredUpsell;

  const plans = await db.getPlansForCountryAndDuration(convo.destination, matchedDuration);

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

// Customer sometimes types a number ("10") instead of tapping a quick-reply
// button. Match it against the GB options we just showed them for their
// destination + duration, and proceed exactly as if they'd tapped it.
async function handlePlanTextReply(senderId, convo, text) {
  const typedGb = parseFloat((text || "").replace(",", ".").match(/[\d.]+/)?.[0] || "");

  if (!Number.isNaN(typedGb)) {
    const plans = await db.getPlansForCountryAndDuration(convo.destination, convo.duration_days);
    const match = plans.find((p) => Number(p.gb) === typedGb);
    if (match) {
      return handlePlanChosen(senderId, match.id);
    }
  }

  // No match — remind them to tap a button instead of guessing silently.
  const plans = await db.getPlansForCountryAndDuration(convo.destination, convo.duration_days);
  await msg.sendQuickReplies(
    senderId,
    "Уучлаарай, дээрх сонголтуудаас сонгоно уу:",
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
    "QPAY төлөх"
  );
  return true;
}

module.exports = { handleMessage, matchDestination, DISPLAY_NAMES };
