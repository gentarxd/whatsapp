import express from "express";
import makeWASocket from "@whiskeysockets/baileys";
import axios from "axios";
import Pino from "pino";
import QRCode from "qrcode";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

// =======================
// In-memory sessions
// =======================
const sessions = {};       // sessionId -> socket
const qrCodes = {};        // sessionId -> qr
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
// Start WhatsApp Socket (in-memory)
// =======================
async function startSock(sessionId) {
  if (!sessionId) throw new Error("sessionId required");

  // In-memory auth
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
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

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

  return sock;
}

// =======================
// API Routes
// =======================

app.post("/create-session", requireApiKey, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  // Response سريع
  res.json({ message: "Session creation started", sessionId });

  // Start in background
  startSock(sessionId).catch(err =>
    console.error("startSock error:", err?.message || err)
  );
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
