import express from "express";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import axios from "axios";
import QRCode from "qrcode";

const app = express();
app.use(express.json());

const sessions = {};       // لتخزين كل sockets الجارية
const qrCodes = {};        // لتخزين QR codes لكل session
const sessionStatus = {};  // حالة كل session: open, close, qr, logged_out
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

const messageQueue = [];
const messageStatus = {}; // حالة كل رسالة: queued | sent | error | no_session

// =======================
// دالة لإنشاء WhatsApp socket in-memory
// =======================
async function startSock(sessionId) {
  if (!sessionId) throw new Error("sessionId required");

  if (sessions[sessionId]) return sessions[sessionId];

  // **auth state in-memory**
  const state = {}; 
  const saveCreds = () => {}; // مش هنحفظ حاجة على القرص

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
  });

  // حفظ credentials في الذاكرة فقط
  sock.ev.on("creds.update", saveCreds);

  // Keep-Alive ping
  const pingInterval = setInterval(() => {
    if (sock?.ws?.readyState === 1) sock.sendPresenceUpdate("available");
  }, 60 * 1000);

  // =======================
  // اتصال / إعادة اتصال
  // =======================
  sock.ev.on("connection.update", (update) => {
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
        console.log(`🔄 Will attempt reconnect to "${sessionId}" in 5s...`);
        delete sessions[sessionId];
        setTimeout(() => startSock(sessionId).catch(console.error), 5000);
      } else {
        sessionStatus[sessionId] = "logged_out";
        clearInterval(pingInterval);
      }
    }
  });

  // =======================
  // استقبال الرسائل
  // =======================
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      null;

    console.log(`💬 New message from ${from}: ${text}`);

    // إرسال للـ webhook
    try {
      await axios.post(
        "https://n8n-latest-znpr.onrender.com/webhook/909d7c73-112a-455b-988c-9f770852c8fa",
        { sessionId, from, text, raw: msg },
        { timeout: 10000 }
      );
    } catch (err) {
      console.error("❌ Error sending to n8n webhook:", err?.message || err);
    }
  });

  sessions[sessionId] = sock;
  return sock;
}

// =======================
// Middleware API Key
// =======================
function requireApiKey(req, res, next) {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// =======================
// Routes
// =======================
app.post("/create-session", requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    await startSock(sessionId);
    res.json({ message: "session created", sessionId });
  } catch (err) {
    console.error("/create-session error:", err?.message || err);
    res.status(500).json({ error: "failed to create session" });
  }
});

app.get("/get-qr/:sessionId", requireApiKey, async (req, res) => {
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
});

app.post("/send-message", requireApiKey, async (req, res) => {
  const { sessionId, phone, text } = req.body;
  if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });

  messageQueue.push({ sessionId, phone, text });
  messageStatus[phone] = "queued";
  res.json({ status: "queued", phone });
});

// =======================
// معالجة الـ Queue
// =======================
setInterval(async () => {
  if (messageQueue.length === 0) return;
  const { sessionId, phone, text } = messageQueue.shift();
  const sock = sessions[sessionId];
  if (!sock) {
    messageStatus[phone] = "no_session";
    return;
  }

  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
    messageStatus[phone] = "sent";
    console.log(`[queue] Sent text to ${phone}`);
  } catch (err) {
    messageStatus[phone] = "error";
    console.error(`[queue] Failed to send to ${phone}:`, err?.message || err);
  }
}, 2000);

// =======================
// الحالة
// =======================
app.get("/status/:sessionId", requireApiKey, (req, res) => {
  const { sessionId } = req.params;
  res.json({ sessionId, status: sessionStatus[sessionId] || "not_found" });
});

app.get("/message-status", requireApiKey, (req, res) => res.json(messageStatus));
app.get("/", (req, res) => res.send("Server is running!"));

// =======================
// بدء السيرفر
// =======================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
