import express from "express";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import Pino from "pino";
import QRCode from "qrcode";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

// =======================
// In-memory sessions
// =======================
const sessions = {};       // sessionId -> sock
const qrCodes = {};        // sessionId -> QR
const sessionStatus = {};  // sessionId -> "qr" | "open" | "close"

// =======================
// Middleware API key
// =======================
function requireApiKey(req, res, next) {
  if (API_KEY) {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// =======================
// Start WhatsApp Socket
// =======================
async function startSock(sessionId) {
  if (!sessionId) throw new Error("sessionId required");

  // In-memory auth (لا يخزن على القرص)
  const authState = {
    creds: {},
    keys: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    }
  };

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: authState,
    logger: Pino({ level: "silent" }),
  });

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

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg?.message) return;

    const from = msg.key.remoteJid;
    const type = Object.keys(msg.message)[0];
    let text = "";
    let media = null;

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
        media = msg.message[type];
        text = media.caption || "";
        break;
    }

    console.log(`💬 New message from ${from}: ${text || type}`);

    // إرسال للـ webhook
    try {
      await axios.post(
        "https://n8n-production-394a.up.railway.app/webhook/909d7c73-112a-455b-988c-9f770852c8fa",
        { sessionId, from, text, type, media },
        { timeout: 10000 }
      );
    } catch (err) {
      console.error("❌ Error sending to n8n webhook:", err?.message || err);
    }
  });

  return sock;
}

// =======================
// API Routes
// =======================

app.post("/create-session", requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    startSock(sessionId);

    // تابع الـ QR
    let qrTimeout;
    const qrPromise = new Promise((resolve, reject) => {
      const checkQR = () => {
        if (qrCodes[sessionId]) {
          clearTimeout(qrTimeout);
          resolve(qrCodes[sessionId]);
        } else if (sessionStatus[sessionId] === "open") {
          clearTimeout(qrTimeout);
          resolve(null);
        } else {
          setTimeout(checkQR, 100);
        }
      };
      checkQR();
      qrTimeout = setTimeout(() => reject(new Error("QR not generated in time")), 20000);
    });

    const qr = await qrPromise;
    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);
      res.json({ sessionId, qr: qrImage });
    } else {
      res.json({ sessionId, message: "Session already active, no QR needed" });
    }

  } catch (err) {
    console.error("/create-session error:", err?.message || err);
    res.status(500).json({ error: "failed to create session" });
  }
});

app.post("/send-message", requireApiKey, async (req, res) => {
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

app.get("/status/:sessionId", requireApiKey, (req, res) => {
  const { sessionId } = req.params;
  res.json({ sessionId, status: sessionStatus[sessionId] || "not_found" });
});

app.get("/", (req, res) => res.send("Server is running!"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
