import express from "express";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import axios from "axios";
import fs from "fs";
import QRCode from "qrcode";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import FormData from "form-data";

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

let preferredSessionId = process.env.PREFERRED_SESSION || null; // ex: "P1WM"
const AUTH_DIR = '/data/auth_info';

const messageQueue = [];
const messageStatus = {}; // { phone: "queued" | "sent" | "error" | "no_session" }

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
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

   const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
// محاكاة متصفح كروم حديث على ويندوز
      browser: ["Windows", "Chrome", "119.0.6045.105"],
      // منع مزامنة التاريخ بالكامل
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
    });


    // Keep-Alive Ping
    const pingInterval = setInterval(() => {
      if (sock?.ws?.readyState === 1) {
        sock.sendPresence("available");
        console.log(`📡 KeepAlive ping sent for ${sessionId}`);
      }
    }, 60 * 1000);

    // حفظ الكريدينشالز
    sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, qr, lastDisconnect } = update;

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
          clearInterval(pingInterval);
          delete sessions[sessionId];

          const statusCode = (lastDisconnect?.error)?.output?.statusCode;
          const errorMsg = (lastDisconnect?.error?.message || "").toLowerCase();

          console.log(`❌ Session ${sessionId} closed. Status: ${statusCode}, Error: ${errorMsg}`);

          // 👇👇👇 التحسين الجذري هنا 👇👇👇
          // إذا كان الخطأ "Connection Failure" أو "Unauthorized" (401)
         // إذا كان الخطأ "Connection Failure" أو 405 (Method Not Allowed) أو 401
          if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 405 || errorMsg.includes("connection failure")) {
              console.log(`⚠️ Critical Error (${statusCode}) for ${sessionId}. Waiting 5s before restart...`);
              
              if (fs.existsSync(authFolder)) {
                  fs.rmSync(authFolder, { recursive: true, force: true });
              }
              
              // 👇 الانتظار هنا هو الحل السحري لفك التعليق
              setTimeout(() => {
                  startSock(sessionId); 
              }, 5000); 
          }

      } catch (e) {
        console.error(`Error in connection.update handler for ${sessionId}:`, e?.message || e);
      }
    });


    // LISTENER للرسائل الجديدة
    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const senderPn = from.split("@")[0];
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
          mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
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
// =======================
// Create Group Route
// =======================
app.post("/create-group", async (req, res) => {
  try {
    const { sessionId, groupName, participants } = req.body;

    // 1. التحقق من البيانات المطلوبة
    if (!sessionId || !groupName || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: "sessionId, groupName, and participants (array) are required" });
    }

    // 2. التأكد من وجود الجلسة
    const sock = sessions[sessionId];
    if (!sock) {
      return res.status(404).json({ error: "session not found" });
    }

    // 3. تحويل الأرقام لصيغة JID
    // بنفترض إنك بتبعت الأرقام كـ strings عادية (مثال: "2010xxxx") زي ما بتعمل في /check
    const pJids = participants.map(phone => `${phone}@s.whatsapp.net`);

    // 4. إنشاء الجروب
    console.log(`Creating group '${groupName}' for session ${sessionId} with ${pJids.length} members...`);
    const group = await sock.groupCreate(groupName, pJids);
    
    // group object بيرجع فيه id و participants
    console.log(`✅ Group created! ID: ${group.id}`);

    // (اختياري) إرسال رسالة ترحيب أول ما الجروب يتعمل
    await sock.sendMessage(group.id, { text: `Welcome to ${groupName}!` });

    res.json({ 
      status: "success", 
      groupId: group.id, 
      groupName: groupName,
      participants: group.participants // بيرجعلك مين انضاف ومين لا (لو فيه privacy settings)
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

  // منع مزامنة التاريخ بالكامل
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
// Message Queue Processor (Modified for Groups)
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

  // التعديل هنا: تحديد نوع الـ JID بذكاء
  let jid;
  if (phone.includes('@')) {
    // لو المبعوت فيه @ يبقى ده JID جاهز (سواء جروب أو شخص)
    jid = phone; 
  } else {
    // لو أرقام بس، يبقى ده رقم شخصي ونضيفله الامتداد
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
