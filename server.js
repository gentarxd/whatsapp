// server.js
import express from "express";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import Pino from "pino";
import axios from "axios";

const app = express();
app.use(express.json());

const sessions = {}; // نخزن السيشنات في RAM

// ✅ API لإنشاء Session جديد
app.post("/create-session", async (req, res) => {
  try {
    const { sessionId, webhookUrl } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    console.log("⚡ Creating session:", sessionId);

    // استخدم MultiFileAuthState
    const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      logger: Pino({ level: "silent" }),
    });

    sessions[sessionId] = { sock, saveCreds, webhookUrl, qr: null };

    // ✅ متابعة حالة الاتصال
    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        sessions[sessionId].qr = qr; // نخزن الكود الخام (مش image)
        console.log("📲 QR Generated for session:", sessionId);
      }

      if (connection === "open") {
        console.log("✅ WhatsApp Connected:", sessionId);
      }

      if (connection === "close") {
        console.log("❌ Connection closed", lastDisconnect?.error);
      }
    });

    // ✅ استقبال الرسائل
    sock.ev.on("messages.upsert", async (m) => {
      const msg = m.messages[0];
      if (!msg.message) return;

      console.log("📩 New message from:", msg.key.remoteJid);

      if (webhookUrl) {
        await axios.post(webhookUrl, {
          sessionId,
          from: msg.key.remoteJid,
          text: msg.message.conversation || null,
        }).catch(e => console.error("Webhook error:", e.message));
      }
    });

    // ✅ حفظ الـ credentials
    sock.ev.on("creds.update", saveCreds);

    res.json({ 
      sessionId, 
      message: "Session created. Open /qr/:sessionId to scan QR" 
    });
  } catch (err) {
    console.error("Create session error:", err);
    res.status(500).json({ error: "failed to create session" });
  }
});

// ✅ API لإرجاع QR كصورة
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session || !session.qr) {
    return res.status(404).json({ error: "QR not available" });
  }

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

// ✅ API لإرسال رسالة
app.post("/send-message", async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });

    await session.sock.sendMessage(to + "@s.whatsapp.net", { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err);
    res.status(500).json({ error: "failed to send message" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
