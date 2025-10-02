import express from "express";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import axios from "axios";
import fs from "fs";
import QRCode from "qrcode";

const app = express();
app.use(express.json());

const sessions = {};
const qrCodes = {};
const sessionStatus = {};
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

let preferredSessionId = process.env.PREFERRED_SESSION || null; // ex: "P1WM"
const AUTH_DIR = '/data/auth_info';

const messageQueue = [];
const messageStatus = {}; // { phone: "queued" | "sent" | "error" | "no_session" }

// =======================
// Start WhatsApp Socket
// =======================
async function startSock(sessionId, webhookUrl = null) {
  try {
    if (!sessionId) throw new Error("sessionId required for startSock");

    if (sessions[sessionId]) {
      console.log(`Session ${sessionId} already exists, returning existing socket.`);
      return sessions[sessionId];
    }

    const authFolder = `${AUTH_DIR}/${sessionId}`;
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
    });

    // ✅ Keep-Alive Ping
    const pingInterval = setInterval(() => {
      if (sock?.ws?.readyState === 1) {
        sock.sendPresenceUpdate("available");
        console.log(`📡 KeepAlive ping sent for ${sessionId}`);
      }
    }, 60 * 1000);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

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

          const shouldReconnect =
            (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect) {
            const target = preferredSessionId || sessionId;
            console.log(`🔄 Will attempt reconnect to "${target}" in 5s...`);

            try { delete sessions[sessionId]; } catch (e) { /* ignore */ }

            setTimeout(() => {
              startSock(target, webhookUrl).catch(e =>
                console.error(`Reconnection error for ${target}:`, e?.message || e)
              );
            }, 5000);
          } else {
            sessionStatus[sessionId] = "logged_out";
            console.log(`Session ${sessionId} logged out. تحتاج QR جديد`);
            clearInterval(pingInterval);
          }
        }
      } catch (e) {
        console.error(`Error in connection.update handler for ${sessionId}:`, e?.message || e);
      }
    });

    // ✅ LISTENER للرسائل
    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          null;

        console.log(`💬 New message from ${from}: ${text}`);

        // اختار الويبهوك
        const targetWebhook =
          webhookUrl ||
          "https://n8n-latest-znpr.onrender.com/webhook-test/909d7c73-112a-455b-988c-9f770852c8fa";

        await axios.post(
          targetWebhook,
          { sessionId, from, text, raw: msg },
          { timeout: 10000 }
        );
      } catch (err) {
        console.error("❌ Error sending to webhook:", err?.message || err);
      }
    });

    sessions[sessionId] = sock;
    return sock;
  } catch (err) {
    console.error(`startSock(${sessionId}) error:`, err?.message || err);
    throw err;
  }
}

// =======================
// Middleware for API key
// =======================
function requireApiKey(req, res, next) {
  if (API_KEY) {
    const header = req.headers["x-api-key"];
    if (header !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// =======================
// Routes
// =======================
app.post("/check", requireApiKey, async (req, res) => {
  try {
    const { sessionId, numbers } = req.body;
    if (!sessionId || !Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: "sessionId and numbers[] required" });
    }

    const sock = sessions[sessionId];
    if (!sock) return res.status(404).json({ error: "session not found" });

    const jids = numbers.map(num => num + "@s.whatsapp.net");
    const results = await sock.onWhatsApp(jids);

    const formatted = numbers.map(num => {
      const jid = num + "@s.whatsapp.net";
      const found = results.find(r => r.jid === jid);
      return { number: num, exists: found?.exists || false };
    });

    res.json({ sessionId, results: formatted });
  } catch (err) {
    console.error("/check error:", err?.message || err);
    res.status(500).json({ error: "failed to check numbers" });
  }
});

app.post("/link-number", requireApiKey, async (req, res) => {
  try {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });

    const authFolder = `${AUTH_DIR}/${sessionId}`;
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
    });

    sock.ev.on("creds.update", saveCreds);

    const code = await sock.requestPairingCode(phone);
    console.log(`Pairing code for ${phone}: ${code}`);

    res.json({ sessionId, phone, code });
  } catch (err) {
    console.error("/link-number error:", err?.message || err);
    res.status(500).json({ error: "failed to link number" });
  }
});

app.post("/set-preferred-session", requireApiKey, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  preferredSessionId = sessionId;
  console.log(`Preferred session set to: ${preferredSessionId}`);
  res.json({ message: "preferred session set", preferredSessionId });
});

app.post("/create-session", requireApiKey, async (req, res) => {
  try {
    const { sessionId, webhookUrl } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    await startSock(sessionId, webhookUrl);

    res.json({
      message: "session created",
      sessionId,
      webhookUrl: webhookUrl || "default"
    });
  } catch (err) {
    console.error("/create-session error:", err?.message || err);
    res.status(500).json({ error: "failed to create session" });
  }
});

app.get("/get-qr/:sessionId", requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const qr = qrCodes[sessionId];

    if (!qr && sessionStatus[sessionId] === "open") {
      return res.json({ status: "success", message: "QR already scanned, session active" });
    }

    if (!qr) return res.status(404).json({ error: "No QR available" });

    try {
      const qrImage = await QRCode.toDataURL(qr);
      const img = Buffer.from(qrImage.split(",")[1], "base64");
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": img.length });
      res.end(img);
    } catch (err) {
      console.error("QR generation error:", err?.message || err);
      res.status(500).json({ error: "failed to generate qr" });
    }
  } catch (err) {
    console.error("/get-qr error:", err?.message || err);
    res.status(500).json({ error: "internal error" });
  }
});

//  Send Message
app.post("/send-message", requireApiKey, async (req, res) => {
  try {
    const { sessionId, number, message } = req.body;
    if (!sessionId || !number || !message)
      return res.status(400).json({ error: "sessionId, number and message required" });

    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "session not found" });

    await session.sendMessage(number + "@s.whatsapp.net", { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("/send-message error:", err?.message || err);
    res.status(500).json({ error: "failed to send message" });
  }
});

// Message Status
app.get("/message-status/:phone", requireApiKey, (req, res) => {
  const { phone } = req.params;
  const status = messageStatus[phone] || "unknown";
  res.json({ phone, status });
});

// Reconnect Session
app.post("/reconnect/:sessionId", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  try {
    await startSock(sessionId);
    res.json({ message: "reconnect triggered", sessionId });
  } catch (err) {
    console.error("/reconnect error:", err?.message || err);
    res.status(500).json({ error: "failed to reconnect" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
