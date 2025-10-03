import express from "express";
import makeWASocket from "@whiskeysockets/baileys";
import Pino from "pino";
import QRCode from "qrcode";
import axios from "axios";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// =======================
// In-memory sessions
// =======================
const sessions = {};       // sessionId -> socket
const qrCodes = {};        // sessionId -> qr
const sessionStatus = {};  // sessionId -> "qr" | "open" | "close"

// =======================
// Start WhatsApp Socket
// =======================
async function startSock(sessionId) {
  const authState = {
    creds: {},
    keys: { get: async () => ({}), set: async () => {}, remove: async () => {} }
  };

  const sock = makeWASocket({ printQRInTerminal: false, auth: authState, logger: Pino({ level: "silent" }) });

  sessions[sessionId] = sock;

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;

    if (qr) {
      qrCodes[sessionId] = qr;
      sessionStatus[sessionId] = "qr";
      console.log(`QR generated for ${sessionId}`);
    }

    if (connection === "open") {
      sessionStatus[sessionId] = "open";
      console.log(`Session ${sessionId} connected ✅`);
      delete qrCodes[sessionId];
    }

    if (connection === "close") {
      sessionStatus[sessionId] = "close";
      console.log(`Session ${sessionId} closed ❌`);
      delete sessions[sessionId];
    }
  });

  // Listener للرسائل
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg?.message) return;

    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    console.log(`💬 New message from ${from}: ${text}`);

    // إرسال للـ webhook
    try {
      await axios.post(
        process.env.WEBHOOK_URL || "https://n8n-production-394a.up.railway.app/webhook-test/909d7c73-112a-455b-988c-9f770852c8fa",
        { sessionId, from, text, raw: msg },
        { timeout: 10000 }
      );
    } catch (err) {
      console.error("❌ Error sending to webhook:", err?.message || err);
    }
  });

  return sock;
}

// =======================
// API
// =======================
app.post("/create-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    await startSock(sessionId);
    res.json({ sessionId, message: "Session created. Use /get-qr/:sessionId to get QR" });
  } catch (err) {
    console.error("/create-session error:", err?.message || err);
    res.status(500).json({ error: "failed to create session" });
  }
});

app.get("/get-qr/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const qr = qrCodes[sessionId];
    if (!qr) return res.status(404).json({ error: "QR not available" });

    const qrImage = await QRCode.toDataURL(qr);
    const img = Buffer.from(qrImage.split(",")[1], "base64");
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": img.length });
    res.end(img);
  } catch (err) {
    console.error("/get-qr error:", err?.message || err);
    res.status(500).json({ error: "failed to get qr" });
  }
});

// إرسال رسالة
app.post("/send-message", async (req, res) => {
  try {
    const { sessionId, phone, text } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });

    const sock = sessions[sessionId];
    if (!sock) return res.status(404).json({ error: "Session not found" });

    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: text || " " });
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("/send-message error:", err?.message || err);
    res.status(500).json({ error: "failed to send message" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
