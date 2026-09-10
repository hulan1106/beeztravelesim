const axios = require("axios");

const GRAPH_URL = "https://graph.facebook.com/v19.0/me/messages";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

function send(recipientId, message) {
  return axios.post(
    GRAPH_URL,
    { recipient: { id: recipientId }, message },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

function sendText(recipientId, text) {
  return send(recipientId, { text });
}

// quickReplies: [{ title, payload }]
function sendQuickReplies(recipientId, text, quickReplies) {
  return send(recipientId, {
    text,
    quick_replies: quickReplies.map((qr) => ({
      content_type: "text",
      title: qr.title,
      payload: qr.payload,
    })),
  });
}

function sendButton(recipientId, text, url, buttonTitle) {
  return send(recipientId, {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: [{ type: "web_url", url, title: buttonTitle, webview_height_ratio: "full" }],
      },
    },
  });
}

// buttons: [{ title, url }] — supports multiple buttons under one message
function sendButtons(recipientId, text, buttons) {
  return send(recipientId, {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: buttons.map((b) => ({
          type: "web_url",
          url: b.url,
          title: b.title,
          webview_height_ratio: "full",
        })),
      },
    },
  });
}

function sendImage(recipientId, imageUrl) {
  return send(recipientId, {
    attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } },
  });
}

module.exports = { sendText, sendQuickReplies, sendButton, sendButtons, sendImage };
