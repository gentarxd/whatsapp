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

// ✅ =======================================================
// ✅ تم تعريف المسار الدائم هنا
// ✅ =======================================================
const AUTH_DIR = '/data/auth_info';

// Queue للرسائل
const messageQueue = [];

// تتبع حالة كل رسالة (كل الأرقام)
const messageStatus = {}; // { phone: "queued" | "sent" | "error" | "no_session" }

// إنشاء الـ WhatsApp socket
async function startSock(sessionId) {
  try {
    // لو الجلسة موجودة مسبقًا نرجعها بدل ما نعمل واحدة جديدة
    if (sessions[sessionId]) {
      console.log(`Session ${sessionId} already exists, returning existing socket.`);
      return sessions[sessionId];
    }

    const authFolder = `${AUTH_DIR}/${sessionId}`;
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
    });

    // حفظ الكريدينشالز
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

          const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
          if (shouldReconnect) {
            console.log(`Reconnecting ${sessionId}...`);
            try {
              if (sessions[sessionId]) {
                try { sessions[sessionId].logout && sessions[sessionId].logout(); } catch(e){/* ignore */ }
              }
            } catch(e){ /* ignore */ }
            startSock(sessionId).catch(e => console.error(`Reconnection error for ${sessionId}:`, e?.message || e));
          } else {
            sessionStatus[sessionId] = "logged_out";
            console.log(`Session ${sessionId} logged out.`);
          }
        }
      } catch (e) {
        console.error(`Error in connection.update handler for ${sessionId}:`, e?.message || e);
      }
    });

    sessions[sessionId] = sock;
    return sock;
  } catch (err) {
    console.error(`startSock(${sessionId}) error:`, err?.message || err);
    throw err;
  }
}

// تحقق من API key إذا موجود
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

// ✅ Create session
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

// ✅ Get QR Code
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

      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": img.length,
      });
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

// ✅ Send message (إضافة للـ Queue بدل الإرسال المباشر)
app.post("/send-message", requireApiKey, async (req, res) => {
  try {
    const { sessionId, phone, text, imageUrl } = req.body;

    if (!sessionId || !phone)
      return res.status(400).json({ error: "sessionId and phone required" });

    messageQueue.push({ sessionId, phone, text, imageUrl });
    messageStatus[phone] = "queued";
    console.log(`[queue] Added message for ${phone}. Queue length: ${messageQueue.length}`);

    res.json({ status: "queued", phone });
  } catch (err) {
    console.error("/send-message error:", err?.message || err);
    res.status(500).json({ error: "failed to queue message" });
  }
});

// Worker يبعث رسالة كل ثانيتين
setInterval(async () => {
  if (messageQueue.length === 0) return;

  const { sessionId, phone, text, imageUrl } = messageQueue.shift();
  const sock = sessions[sessionId];

  if (!sock) {
    console.error(`[queue] No session found: ${sessionId}`);
    messageStatus[phone] = "no_session";
    return;
  }

  const jid = `${phone}@s.whatsapp.net`;

  try {
    if (imageUrl) {
      let sent = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt < 3) {
            // أول محاولتين بالـ image
            const response = await axios.get(imageUrl, {
              responseType: "arraybuffer",
              timeout: 60000 // دقيقة
            });

            let buffer = Buffer.from(response.data, "binary");
            const sharp = (await import("sharp")).default;
            buffer = await sharp(buffer).jpeg().toBuffer();

            await sock.sendMessage(jid, {
              image: buffer,
              caption: text || ""
            }, { thumbnail: null });

            console.log(`[queue] Sent image (attempt ${attempt}) to ${phone}`);
          } else {
            // المحاولة الثالثة: text فقط
            await sock.sendMessage(jid, { text: text || " " });
            console.log(`[queue] Sent text fallback to ${phone}`);
          }

          messageStatus[phone] = "sent";
          sent = true;
          break;
        } catch (err) {
          console.error(`[queue] Error attempt ${attempt} for ${phone}:`, err.message);
        }
      }

      if (!sent) {
        messageStatus[phone] = "error";
        console.error(`[queue] All attempts failed for ${phone}`);
      }

    } else {
      // لو مفيش صورة أصلا يبعت text عادي
      await sock.sendMessage(jid, { text });
      console.log(`[queue] Sent text to ${phone}`);
      messageStatus[phone] = "sent";
    }
  } catch (err) {
    console.error(`[queue] Fatal error sending to ${phone}:`, err.message);
    messageStatus[phone] = "error";
  }
}, 2000);


// ✅ Endpoint لتتبع حالة كل الرسائل
app.get("/message-status", requireApiKey, (req, res) => {
  try {
    res.json(messageStatus);
  } catch (err) {
    console.error("/message-status error:", err?.message || err);
    res.status(500).json({ error: "failed to get message status" });
  }
});

// ✅ Session status check
app.get("/status/:sessionId", requireApiKey, (req, res) => {
  try {
    const { sessionId } = req.params;
    res.json({ sessionId, status: sessionStatus[sessionId] || "not_found" });
  } catch (err) {
    console.error("/status error:", err?.message || err);
    res.status(500).json({ error: "failed to get session status" });
  }
});

// ✅ Health check
app.get("/", (req, res) => {
  res.send("Server is running!");
});

// ✅ دالة لإعادة توصيل الجلسات عند بدء التشغيل
const reconnectSessions = () => {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      const sessionFolders = fs.readdirSync(AUTH_DIR);
      console.log(`Found ${sessionFolders.length} session(s) to reconnect.`);
      sessionFolders.forEach(sessionId => {
        console.log(`🚀 Reconnecting session: ${sessionId}`);
        startSock(sessionId).catch(e => console.error(`Reconnect failed for ${sessionId}:`, e?.message || e));
      });
    } else {
      console.log(`Auth directory not found, creating one at: ${AUTH_DIR}`);
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
  } catch (err) {
    console.error("reconnectSessions error:", err?.message || err);
  }
};

reconnectSessions();

// Global handlers لمنع السيرفر من السقوط
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err?.message || err);
});

process.on('unhandledRejection', (reason, p) => {
  console.error('unhandledRejection at:', p, 'reason:', reason);
});

app.use((err, req, res, next) => {
  console.error('Express error middleware:', err?.message || err);
  res.status(500).json({ error: 'internal_server_error' });
});

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
