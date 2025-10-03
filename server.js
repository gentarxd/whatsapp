// server.js
import express from "express";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import Pino from "pino";
import axios from "axios";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import fs from "fs";

const app = express();
app.use(express.json());

const sessions = {}; // نخزن السيشنات

// =======================
// Function لإنشاء Session
// =======================
async function createSession(sessionId, webhookUrl) {
  const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: Pino({ level: "silent" }),
  });

  sessions[sessionId] = { sock, saveCreds, webhookUrl, qr: null };

  // =======================
  // Connection updates
  // =======================
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      sessions[sessionId].qr = qr;
      console.log("📲 QR Generated for session:", sessionId);
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected:", sessionId);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed", reason, sessionId);

      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          console.log("🔄 Reconnecting session:", sessionId);
          createSession(sessionId, webhookUrl);
        }, 2000);
      }
    }
  });

  // =======================
  // استقبال الرسائل
  // =======================
 sock.ev.on("messages.upsert", async (m) => {
  const msg = m.messages[0];
  if (!msg?.message) return;

  const from = msg.key.remoteJid;
  if (!from.endsWith("@s.whatsapp.net")) return;

  console.log("📩 New message from:", from);

  // استخراج النص أو نوع الرسالة
  let text = "";
  let type = Object.keys(msg.message)[0]; // نوع الرسالة: conversation, imageMessage, etc.
  let mediaData = null;

  switch (type) {
    case "conversation":
      text = msg.message.conversation;
      break;
    case "extendedTextMessage":
      text = msg.message.extendedTextMessage.text;
      break;
    case "imageMessage":
    case "videoMessage":
    case "documentMessage":
    case "audioMessage":
      mediaData = msg.message[type];
      text = mediaData.caption || ""; // لو فيه caption
      break;
    default:
      text = "";
  }

  // إرسال للـ webhook
  if (webhookUrl) {
    try {
      await axios.post(webhookUrl, {
        sessionId,
        from,
        type,
        text,
        media: mediaData ? mediaData : null,
      });
    } catch (err) {
      console.error("Webhook error:", err.response?.data || err.message);
    }
  }
});


  // =======================
  // حفظ الـ credentials
  // =======================
  sock.ev.on("creds.update", saveCreds);

  return sock;
}

// =======================
// API لإنشاء Session
// =======================
app.post("/create-session", async (req, res) => {
  try {
    const { sessionId, webhookUrl } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    await createSession(sessionId, webhookUrl);
    res.json({ sessionId, message: "Session created. Open /qr/:sessionId to scan QR" });
  } catch (err) {
    console.error("Create session error:", err);
    res.status(500).json({ error: "failed to create session" });
  }
});

// =======================
// API لإرجاع QR
// =======================
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session || !session.qr) return res.status(404).json({ error: "QR not available" });

  try {
    const qrImage = await qrcode.toBuffer(session.qr);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": qrImage.length,
    });
    res.end(qrImage);
  } catch (err) {
    console.error("QR generation error:", err);
    res.status(500).json({ error: "failed to generate QR" });
  }
});

// =======================
// API لإرسال رسالة
// =======================
app.post("/send-message", async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;
    const session = sessions[sessionId];
    if (!session || !session.sock) return res.status(404).json({ error: "Session not found" });

    if (!message || !message.toString().trim()) return res.status(400).json({ error: "Message is empty" });

    const jid = to.replace(/\D/g, "") + "@s.whatsapp.net";
    const text = message.toString().trim() || " ";

    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      try {
        await session.sock.sendMessage(jid, { text });
        return res.json({ success: true, to: jid });
      } catch (err) {
        attempt++;
        console.error(`Attempt ${attempt} failed:`, err.message);
        if (attempt >= maxAttempts) throw err;
        console.log("Retrying...");
      }
    }

  } catch (err) {
    console.error("Send error full:", err);
    res.status(500).json({ error: "failed to send message", details: err.message });
  }
});

// =======================
// تشغيل السيرفر
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
