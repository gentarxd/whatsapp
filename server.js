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


// إنشاء الـ WhatsApp socket
async function startSock(sessionId) {
  // ✅ =======================================================
  // ✅ تم استخدام المسار الدائم هنا لحفظ الجلسات
  // ✅ =======================================================
  const authFolder = `${AUTH_DIR}/${sessionId}`;
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

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

      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log(`Reconnecting ${sessionId}...`);
        startSock(sessionId);
      }
    }
  });

  sessions[sessionId] = sock;
  return sock;
}

// تحقق من API key إذا موجود
function requireApiKey(req, res, next) {
  if (API_KEY) {
    const header = req.headers["x-api-key"];
    if (header !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ✅ Create session
app.post("/create-session", requireApiKey, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  await startSock(sessionId);
  res.json({ message: "session created", sessionId });
});

// ✅ Get QR Code
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

    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": img.length,
    });
    res.end(img);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send message
// ✅ Send message (النسخة الجديدة الذكية)
app.post("/send-message", requireApiKey, async (req, res) => {
  const { sessionId, phone, text, imageUrl } = req.body;

  if (!sessionId || !phone)
    return res.status(400).json({ error: "sessionId and phone required" });
  
  console.log(`[send-message] Request for session: ${sessionId}. Current status: ${sessionStatus[sessionId]}`);

  // --- بداية الكود الذكي ---
  // إذا كانت الجلسة غير متصلة، حاول إعادة توصيلها
  if (sessionStatus[sessionId] !== "open" || !sessions[sessionId]) {
    console.log(`[send-message] Session "${sessionId}" not ready. Attempting to reconnect...`);
    const authFolder = `${AUTH_DIR}/${sessionId}`;
    
    // تحقق أولاً من وجود ملفات الجلسة
    if (fs.existsSync(authFolder)) {
      try {
        await startSock(sessionId);
        // امنحها 5 ثوانٍ للاتصال
        await new Promise(resolve => setTimeout(resolve, 5000)); 
        
        console.log(`[send-message] Re-checked status: ${sessionStatus[sessionId]}`);
        
        // إذا فشل الاتصال مرة أخرى، قم بإرجاع خطأ
        if (sessionStatus[sessionId] !== "open") {
          return res.status(400).json({ error: "Session failed to connect after auto-reconnect attempt." });
        }
      } catch (e) {
        console.error(`[send-message] Error during reconnect attempt:`, e);
        return res.status(500).json({ error: "Failed to start session during send." });
      }
    } else {
      // إذا لم تكن هناك ملفات، فلا يمكن فعل شيء
      return res.status(400).json({ error: "Session files not found. Please create session and scan QR again." });
    }
  }
  // --- نهاية الكود الذكي ---


  const sock = sessions[sessionId];
  if (!sock) {
    return res.status(400).json({ error: "Fatal: Sock object not found even after check." });
  }

  try {
    const jid = `${phone}@s.whatsapp.net`;
    console.log(`[send-message] Sending message to ${jid}`);

    if (imageUrl) {
      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data, "binary");

      await sock.sendMessage(jid, { image: buffer, caption: text || "" });
    } else {
      await sock.sendMessage(jid, { text });
    }

    res.json({
      status: "success",
      message: "Message sent successfully",
      phone
    });
    console.log(`[send-message] Message sent successfully to ${jid}`);
  } catch (e) {
    console.error(`[send-message] Error sending message:`, e);
    res.status(500).json({ error: e.message });
  }
});
// ✅ Session status check
app.get("/status/:sessionId", requireApiKey, (req, res) => {
  const { sessionId } = req.params;
  res.json({ sessionId, status: sessionStatus[sessionId] || "not_found" });
});

// ✅ Health check
app.get("/", (req, res) => {
  res.send("Server is running!");
});

// ✅ دالة لإعادة توصيل الجلسات عند بدء التشغيل
const reconnectSessions = () => {
  // ✅ =======================================================
  // ✅ تم استخدام المسار الدائم هنا لقراءة الجلسات
  // ✅ =======================================================
  if (fs.existsSync(AUTH_DIR)) {
    const sessionFolders = fs.readdirSync(AUTH_DIR);
    console.log(`Found ${sessionFolders.length} session(s) to reconnect.`);
    sessionFolders.forEach(sessionId => {
      console.log(`🚀 Reconnecting session: ${sessionId}`);
      startSock(sessionId);
    });
  } else {
    console.log(`Auth directory not found, creating one at: ${AUTH_DIR}`);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
};

// قم باستدعاء الدالة عند بدء تشغيل الخادم
reconnectSessions();

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
