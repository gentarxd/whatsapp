import express from "express";
import makeWASocket from "@whiskeysockets/baileys";
import Pino from "pino";
import QRCode from "qrcode";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

const sessions = {};
const qrCodes = {};
const sessionStatus = {};

function requireApiKey(req, res, next) {
  if (API_KEY) {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

async function startSock(sessionId) {
  if (!sessionId) throw new Error("sessionId required");

  const authState = {
    creds: {},
    keys: { get: async () => ({}), set: async () => {}, remove: async () => {} }
  };

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: authState,
    logger: Pino({ level: "silent" }),
  });

  sessions[sessionId] = sock;

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;
    if (qr) { qrCodes[sessionId] = qr; sessionStatus[sessionId] = "qr"; }
    if (connection === "open") { sessionStatus[sessionId] = "open"; delete qrCodes[sessionId]; }
    if (connection === "close") { sessionStatus[sessionId] = "close"; delete sessions[sessionId]; }
  });

  // إرسال كل الرسائل للـ webhook
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg?.message) return;

    const from = msg.key.remoteJid;
    let type = Object.keys(msg.message)[0];
    let text = "";
    let mediaBase64 = null;

    switch(type) {
      case "conversation":
        text = msg.message.conversation;
        break;
      case "extendedTextMessage":
        text = msg.message.extendedTextMessage.text;
        break;
      case "imageMessage":
      case "videoMessage":
      case "audioMessage":
      case "documentMessage":
        const media = msg.message[type];
        text = media.caption || "";
        try {
          const buffer = await sock.downloadMediaMessage(msg, "buffer");
          mediaBase64 = buffer.toString("base64");
        } catch(err) {
          console.error("Failed to download media:", err?.message || err);
        }
        break;
      default:
        text = "";
    }

    try {
      await axios.post(
        "https://n8n-production-394a.up.railway.app/webhook-test/909d7c73-112a-455b-988c-9f770852c8fa",
        { sessionId, from, type, text, media: mediaBase64, raw: msg },
        { timeout: 10000 }
      );
    } catch (err) {
      console.error("❌ Error sending to webhook:", err?.message || err);
    }
  });

  return sock;
}

// ---------------- API ----------------

app.post("/create-session", requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const sockPromise = startSock(sessionId);
    let qrTimeout;
    const qrPromise = new Promise((resolve, reject) => {
      const checkQR = () => {
        if (qrCodes[sessionId]) { clearTimeout(qrTimeout); resolve(qrCodes[sessionId]); }
        else if (sessionStatus[sessionId] === "open") { clearTimeout(qrTimeout); resolve(null); }
        else setTimeout(checkQR, 100);
      };
      checkQR();
      qrTimeout = setTimeout(() => reject(new Error("QR not generated in time")), 20000);
    });

    const qr = await qrPromise;
    await sockPromise;

    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);
      res.json({ sessionId, qr: qrImage });
    } else {
      res.json({ sessionId, message: "Session already active, no QR needed" });
    }

  } catch(err) {
    console.error("/create-session error:", err?.message || err);
    res.status(500).json({ error: "failed to create session" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
