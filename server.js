import express from "express";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import axios from "axios";
import fs from "fs";
import QRCode from "qrcode";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import FormData from "form-data";
import P from 'pino'; // 1. إضافة مكتبة Pino لمنع الانهيار

if (!fs.existsSync("./downloads")) {
  fs.mkdirSync("./downloads", { recursive: true });
}

const app = express();
app.use(express.json());

const sessions = {};
const qrCodes = {};
const sessionStatus = {};
const reconnectAttempts = {};
const qrGenerationAttempts = {};
const PORT = process.env.PORT || 3000;

// 2. متغيرات الإيقاف المؤقت
const pausedNumbers = {}; 
const PAUSE_DURATION_MS = 60 * 60 * 1000; // ساعة واحدة

let preferredSessionId = process.env.PREFERRED_SESSION || null; 
const AUTH_DIR = '/data/auth_info';

const messageQueue = [];
const messageStatus = {}; 

// =======================
// Start WhatsApp Socket
// =======================
async function startSock(sessionId) {
  try {
    if (!sessionId) throw new Error("sessionId required for startSock");

    if (sessions[sessionId]) {
      console.log(`Session ${sessionId} already exists, returning existing socket.`);
      return sessions[sessionId];
    }

    const authFolder = `${AUTH_DIR}/${sessionId}`;
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    
    // 3. تنظيف الجلسة عند البدء لضمان عدم وجود ملفات تالفة (مهم لـ Render)
    if (!sessions[sessionId]) {
        if (fs.existsSync(authFolder)) {
             // حذف المجلد القديم لبدء جلسة نظيفة
             // fs.rmSync(authFolder, { recursive: true, force: true }); 
             // ملاحظة: تركت السطر تعليقاً لكي لا يحذف جلساتك القديمة المحفوظة، 
             // لكن يفضل تفعيله لو واجهت مشاكل Loop
        }
        if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      // 4. إضافة اللوجر الصامت وإعداد المتصفح الصحيح
      logger: P({ level: "silent" }),
      browser: ["Ubuntu", "Chrome", "20.0.04"], 
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
    });

    const pingInterval = setInterval(() => {
      if (sock?.ws?.readyState === 1) {
        sock.sendPresence("available");
        console.log(`📡 KeepAlive ping sent for ${sessionId}`);
      }
    }, 60 * 1000);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      try {
        const { connection, qr, lastDisconnect } = update; // أضفنا lastDisconnect

        if (!qrGenerationAttempts[sessionId]) qrGenerationAttempts[sessionId] = 0;

        if (qr) {
          qrGenerationAttempts[sessionId]++;
          if (qrGenerationAttempts[sessionId] > 5) {
            console.warn(`⚠️ QR generation limit reached for ${sessionId}.`);
            sessionStatus[sessionId] = "qr_limit_reached";
            return; 
          }
          qrCodes[sessionId] = qr;
          sessionStatus[sessionId] = "qr";
          console.log(`QR generated for ${sessionId} (Attempt ${qrGenerationAttempts[sessionId]}/5)`);
        }

        if (connection === "open") {
          sessionStatus[sessionId] = "open";
          console.log(`✅ Session ${sessionId} connected`);
          delete qrCodes[sessionId];
          qrGenerationAttempts[sessionId] = 0; 
        }

        if (connection === "close") {
          sessionStatus[sessionId] = "close";
          console.log(`❌ Session ${sessionId} closed — reconnecting in 3s...`);
          clearInterval(pingInterval);
          delete sessions[sessionId];

          // معالجة أخطاء التوثيق (تلف الملفات)
          const statusCode = (lastDisconnect?.error)?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
              console.log(`Session ${sessionId} logged out or corrupted. Deleting files...`);
              if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
          } else {
              setTimeout(async () => {
                try {
                  console.log(`🔁 Reconnecting session: ${sessionId}`);
                  await startSock(sessionId);
                } catch (err) {
                  console.error(`Reconnect failed for ${sessionId}:`, err?.message || err);
                }
              }, 3000);
          }
        }

      } catch (e) {
        console.error(`Error in connection.update handler for ${sessionId}:`, e?.message || e);
      }
    });

    // LISTENER للرسائل الجديدة (معدل لإضافة ميزة الإيقاف)
    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const senderPn = from ? from.split("@")[0] : "";
        
        // 5. منطق التدخل البشري (Pause on Reply)
        if (msg.key.fromMe) {
            // التحقق: هل قمت بعمل Reply؟
            const isReply = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (isReply) {
                const unpauseTime = Date.now() + PAUSE_DURATION_MS;
                pausedNumbers[senderPn] = unpauseTime;
                console.log(`[HUMAN INTERVENTION] You replied to ${senderPn}. Bot paused for 1 hour.`);
            }
            return; // لا تكمل المعالجة للرسائل الصادرة منك
        }

        // 6. التحقق: هل الرقم موقوف مؤقتاً؟
        if (pausedNumbers[senderPn]) {
            if (Date.now() < pausedNumbers[senderPn]) {
                console.log(`[PAUSED] Ignoring message from ${senderPn} because you replied recently.`);
                return; // لا ترسل للويبهوك
            } else {
                delete pausedNumbers[senderPn];
                console.log(`[RESUME] Bot active again for ${senderPn}`);
            }
        }
        
        // --- باقي الكود كما هو ---
        const type = Object.keys(msg.message)[0];
        const session = sessionId;

        let text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption ||
          msg.message.audioMessage?.caption ||
          null;

        let mediaBuffer = null;
        let mediaType = null;
        let fileName = null;
        let mimeType = null;

        if (msg.message.imageMessage) {
          mediaType = "image";
          mimeType = msg.message.imageMessage.mimetype;
          fileName = "image.jpg";
          mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null }); // هنا null عادي للميديا
        } else if (msg.message.documentMessage) {
          mediaType = "document";
          mimeType = msg.message.documentMessage.mimetype;
          fileName = msg.message.documentMessage.fileName || "document";
          mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
        } else if (msg.message.videoMessage) {
          mediaType = "video";
          mimeType = msg.message.videoMessage.mimetype;
          fileName = "video.mp4";
          mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
        } else if (msg.message.audioMessage) {
          mediaType = "audio";
          mimeType = msg.message.audioMessage.mimetype;
          fileName = "audio.mp3";
          mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
        }

        if (mediaType) {
          console.log(`💬 New ${mediaType.toUpperCase()} message from ${from}`);
        } else {
          console.log(`💬 New text message from ${from}: ${text}`);
        }

        const form = new FormData();
        form.append("sessionId", session);
        form.append("from", from);
        form.append("senderPn", senderPn);
        form.append("type", type);
        form.append("text", text || "");
        form.append("mediaType", mediaType || "");
        form.append("mimeType", mimeType || "");
        form.append("fileName", fileName || "");
        form.append("raw", JSON.stringify(msg));

        if (mediaBuffer) {
          form.append("file", mediaBuffer, { filename: fileName, contentType: mimeType });
        }

        await axios.post(
          "https://n8n.gentar.cloud/webhook/909d7c73-112a-455b-988c-9f770852c8fa",
          form,
          { headers: form.getHeaders(), timeout: 20000 }
        );

        console.log(`✅ Message sent to webhook${mediaBuffer ? " with file" : ""}`);
      } catch (err) {
        console.error("❌ Error sending message to webhook:", err?.message || err);
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
// Routes
// =======================
app.post("/create-group", async (req, res) => {
  try {
    const { sessionId, groupName, participants } = req.body;

    if (!sessionId || !groupName || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: "sessionId, groupName, and participants (array) are required" });
    }

    const sock = sessions[sessionId];
    if (!sock) {
      return res.status(404).json({ error: "session not found" });
    }

    const pJids = participants.map(phone => `${phone}@s.whatsapp.net`);

    console.log(`Creating group '${groupName}' for session ${sessionId} with ${pJids.length} members...`);
    const group = await sock.groupCreate(groupName, pJids);
    
    console.log(`✅ Group created! ID: ${group.id}`);
    await sock.sendMessage(group.id, { text: `Welcome to ${groupName}!` });

    res.json({ 
      status: "success", 
      groupId: group.id, 
      groupName: groupName,
      participants: group.participants 
    });

  } catch (err) {
    console.error("/create-group error:", err?.message || err);
    res.status(500).json({ error: "failed to create group" });
  }
});

app.post("/check", async (req, res) => {
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
      return {
        number: num,
        exists: found?.exists || false
      };
    });

    res.json({ sessionId, results: formatted });
  } catch (err) {
    console.error("/check error:", err?.message || err);
    res.status(500).json({ error: "failed to check numbers" });
  }
});

app.post("/link-number", async (req, res) => {
  try {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) {
      return res.status(400).json({ error: "sessionId and phone required" });
    }

    const authFolder = `${AUTH_DIR}/${sessionId}`;
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      logger: P({ level: "silent" }), // Added Pino here too
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
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

app.post("/set-preferred-session", (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    preferredSessionId = sessionId;
    console.log(`Preferred session set to: ${preferredSessionId}`);
    res.json({ message: "preferred session set", preferredSessionId });
  } catch (err) {
    console.error("/set-preferred-session error:", err?.message || err);
    res.status(500).json({ error: "failed to set preferred session" });
  }
});

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

app.get("/get-qr/:sessionId", async (req, res) => {
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

app.post("/send-message", async (req, res) => {
  try {
    const { sessionId, phone, text, imageUrl } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });

    messageQueue.push({ sessionId, phone, text, imageUrl });
    messageStatus[phone] = "queued";
    console.log(`[queue] Added message for ${phone}. Queue length: ${messageQueue.length}`);
    res.json({ status: "queued", phone });
  } catch (err) {
    console.error("/send-message error:", err?.message || err);
    res.status(500).json({ error: "failed to queue message" });
  }
});

// =======================
// Message Queue Processor
// =======================
setInterval(async () => {
  if (messageQueue.length === 0) return;

  const { sessionId, phone, text, imageUrl } = messageQueue.shift();
  const sock = sessions[sessionId];
  
  if (!sock) {
    console.error(`[queue] No session found: ${sessionId}`);
    messageStatus[phone] = "no_session";
    return;
  }

  let jid;
  if (phone.includes('@')) {
    jid = phone; 
  } else {
    jid = `${phone}@s.whatsapp.net`;
  }

  try {
    if (imageUrl) {
      let sent = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt < 3) {
            const response = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 60000 });
            let buffer = Buffer.from(response.data, "binary");
            await sock.sendMessage(jid, { image: buffer, caption: text || "", jpegThumbnail: null });
            console.log(`[queue] Sent image (attempt ${attempt}) to ${jid}`);
          } else {
            await sock.sendMessage(jid, { text: text || " " });
            console.log(`[queue] Sent text fallback to ${jid}`);
          }
          messageStatus[phone] = "sent";
          sent = true;
          break;
        } catch (err) {
          console.error(`[queue] Error attempt ${attempt} for ${jid}:`, err?.message || err);
          if ((err?.message || "").toLowerCase().includes("connection closed")) {
            console.log(`[queue] Detected Connection Closed. Will try reconnect.`);
            try { delete sessions[sessionId]; } catch(e){}
            const target = preferredSessionId || sessionId;
            setTimeout(() => startSock(target).catch(e => console.error(`Reconnection error:`, e)), 3000);
          }
        }
      }
      if (!sent) {
        messageStatus[phone] = "error";
        console.error(`[queue] All attempts failed for ${jid}`);
      }
    } else {
      await sock.sendMessage(jid, { text });
      console.log(`[queue] Sent text to ${jid}`);
      messageStatus[phone] = "sent";
    }
  } catch (err) {
    console.error(`[queue] Fatal error sending to ${jid}:`, err?.message || err);
    messageStatus[phone] = "error";
  }
}, 2000);

app.get("/message-status", (req, res) => {
  try { res.json(messageStatus); }
  catch (err) { console.error("/message-status error:", err?.message || err); res.status(500).json({ error: "failed to get message status" }); }
});

app.get("/status/:sessionId", (req, res) => {
  try { const { sessionId } = req.params; res.json({ sessionId, status: sessionStatus[sessionId] || "not_found" }); }
  catch (err) { console.error("/status error:", err?.message || err); res.status(500).json({ error: "failed to get session status" }); }
});

app.get("/", (req, res) => { res.send("Server is running!"); });

const reconnectSessions = () => {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      let sessionFolders = fs.readdirSync(AUTH_DIR);
      if (preferredSessionId) {
        sessionFolders = sessionFolders.filter(s => s !== preferredSessionId);
        sessionFolders.unshift(preferredSessionId);
      }
      console.log(`Found ${sessionFolders.length} session(s) to reconnect.`);
      sessionFolders.forEach(sessionId => {
        console.log(`🚀 Reconnecting session: ${sessionId}`);
        startSock(sessionId).catch(e => console.error(`Reconnect failed for ${sessionId}:`, e?.message || e));
      });
    } else {
      console.log(`Auth directory not found, creating one at: ${AUTH_DIR}`);
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
  } catch (err) { console.error("reconnectSessions error:", err?.message || err); }
};

reconnectSessions();

process.on('uncaughtException', (err) => { console.error('uncaughtException:', err?.message || err); });
process.on('unhandledRejection', (reason, p) => { console.error('unhandledRejection at:', p, 'reason:', reason); });

app.use((err, req, res, next) => {
  console.error('Express error middleware:', err?.message || err);
  res.status(500).json({ error: 'internal_server_error' });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
