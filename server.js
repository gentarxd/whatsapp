import express from "express";
import makeWASocket, { useSingleFileAuthState } from "@whiskeysockets/baileys";
import axios from "axios";
import QRCode from "qrcode";

const app = express();
app.use(express.json());

const sessions = {};   // { sessionId: { sock, webhookUrl } }
const qrCodes = {};    // نخزن الـ QR مؤقت
const sessionStatus = {}; // حالة السيشن
const PORT = process.env.PORT || 3000;

// =======================
// Start WhatsApp Socket
// =======================
async function startSock(sessionId) {
  if (!sessionId) throw new Error("sessionId required");

  if (sessions[sessionId]) {
    console.log(`♻️ Session ${sessionId} already exists`);
    return sessions[sessionId];
  }

  // auth مؤقت (RAM)
  const { state, saveCreds } = useSingleFileAuthState("");
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;

    if (qr) {
      qrCodes[sessionId] = qr;
      sessionStatus[sessionId] = "qr";
      console.log(`📸 QR generated for ${sessionId}`);
    }

    if (connection === "open") {
      sessionStatus[sessionId] = "open";
      console.log(`✅ Session ${sessionId} connected`);
      delete qrCodes[sessionId];
    }

    if (connection === "close") {
      sessionStatus[sessionId] = "closed";
      console.log(`❌ Session ${sessionId} closed`);
    }
  });

  // listener للرسائل
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      null;

    console.log(`💬 Message from ${from}: ${text}`);

    // لو في webhook متسجل للسيشن
    if (sessions[sessionId].webhookUrl) {
      try {
        await axios.post(sessions[sessionId].webhookUrl, {
          sessionId,
          from,
          text,
          raw: msg,
        });
      } catch (err) {
        console.error("❌ Webhook error:", err?.message || err);
      }
    }
  });

  sessions[sessionId] = { sock, webhookUrl: null };
  return sock;
}

// =======================
// Routes
// =======================

// إنشاء سيشن
app.post("/create-session", async (req, res) => {
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

// تعيين/تحديث Webhook
app.post("/set-webhook", (req, res) => {
  const { sessionId, webhookUrl } = req.body;
  if (!sessionId || !webhookUrl)
    return res.status(400).json({ error: "sessionId and webhookUrl required" });

  if (!sessions[sessionId]) return res.status(404).json({ error: "session not found" });

  sessions[sessionId].webhookUrl = webhookUrl;
  res.json({ message: "webhook updated", sessionId, webhookUrl });
});

// إحضار QR
app.get("/get-qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes[sessionId];

  if (!qr && sessionStatus[sessionId] === "open") {
    return res.json({ status: "success", message: "QR already scanned, session active" });
  }

  if (!qr) return res.status(404).json({ error: "No QR available" });

  const qrImage = await QRCode.toDataURL(qr);
  const img = Buffer.from(qrImage.split(",")[1], "base64");
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": img.length });
  res.end(img);
});

// إرسال رسالة
app.post("/send-message", async (req, res) => {
  try {
    const { sessionId, number, message } = req.body;
    if (!sessionId || !number || !message)
      return res.status(400).json({ error: "sessionId, number and message required" });

    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "session not found" });

    await session.sock.sendMessage(number + "@s.whatsapp.net", { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("/send-message error:", err?.message || err);
    res.status(500).json({ error: "failed to send message" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
