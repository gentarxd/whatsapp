import express from "express";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import axios from "axios";
import fs from "fs";
import QRCode from "qrcode";
import FormData from "form-data";
import path from "path";
import process from "process";
import { fileURLToPath } from 'url';
import P from 'pino';

// ---- Config
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_NAME = process.env.PROJECT_NAME || "whatsapp-bot";
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "temp_auth"); 
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://n8n.gentar.cloud/webhook/909d7c73-112a-455b-988c-9f770852c8fa";
const PAUSE_DURATION_MS = 60 * 60 * 1000; // ساعة واحدة

// ---- Global Variables
const sessions = {};
const qrCodes = {};
const sessionStatus = {};
const pausedNumbers = {}; // التخزين في الذاكرة (RAM)

// ---- Ensure Clean Start
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ---- WhatsApp socket
async function startSock(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  
  const authFolder = path.join(AUTH_DIR, sessionId);

  // تنظيف الجلسة عند البدء لضمان عدم وجود ملفات تالفة
  if (!sessions[sessionId]) {
      if (fs.existsSync(authFolder)) {
          fs.rmSync(authFolder, { recursive: true, force: true });
      }
      fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodes[sessionId] = qr;
      sessionStatus[sessionId] = "qr";
    }

    if (connection === "open") {
      sessionStatus[sessionId] = "open";
      delete qrCodes[sessionId];
      console.log(`[${PROJECT_NAME}] Session ${sessionId} is ACTIVE ✅`);
    }

    if (connection === "close") {
      delete sessions[sessionId];
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
          if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
      } else if (shouldReconnect) {
          startSock(sessionId);
      }
    }
  });

  // ---- معالجة الرسائل ----
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const isFromMe = msg.key.fromMe;
    const phoneNumber = remoteJid ? remoteJid.split('@')[0] : "";

    // --- (1) منطق التدخل البشري (Human Handover) ---
    if (isFromMe) {
        // التحقق: هل هذه الرسالة "رد" (Reply) على رسالة سابقة؟
        // الـ Reply يكون نوعه extendedTextMessage ويحتوي على contextInfo.quotedMessage
        const isReply = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        if (isReply) {
            // هذا تدخل بشري (أنت عملت ريبلاي) -> تفعيل الإيقاف
            const unpauseTime = Date.now() + PAUSE_DURATION_MS;
            pausedNumbers[phoneNumber] = unpauseTime;
            console.log(`[HUMAN INTERVENTION] You replied to ${phoneNumber}. Bot paused for 1 hour.`);
        } else {
            // هذه رسالة عادية (غالباً من البوت نفسه أو إرسال بدون رد) -> تجاهل
            // لن نفعل شيئاً، ولن نوقف البوت
        }
        return; 
    }

    // --- (2) منطق استلام رسائل العملاء ---
    
    // تجاهل رسائل الـ Status
    if (remoteJid === "status@broadcast") return;

    // هل العميل في قائمة الإيقاف المؤقت؟
    if (pausedNumbers[phoneNumber]) {
        if (Date.now() < pausedNumbers[phoneNumber]) {
            console.log(`[PAUSED] Ignoring message from ${phoneNumber} because you replied recently.`);
            return; // لا ترسل للويبهوك
        } else {
            delete pausedNumbers[phoneNumber]; // انتهى الوقت
            console.log(`[RESUME] Bot active again for ${phoneNumber}`);
        }
    }

    // استخراج النص
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    
    // (يمكنك إضافة منطق تحميل الصور هنا إذا أردت)

    if (!text) return;

    // إرسال للويبهوك
    try {
        const form = new FormData();
        form.append("sessionId", sessionId);
        form.append("from", remoteJid);
        form.append("text", text);
        
        await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders() });
        console.log(`[Webhook] Forwarded message from ${phoneNumber}`);
    } catch (e) {
        console.error("[Webhook Error]", e.message);
    }
  });

  sessions[sessionId] = sock;
  return sock;
}

// ---- Express
const app = express();
app.use(express.json());

app.post("/create-session", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  await startSock(sessionId);
  res.json({ message: "Session initialized. Scan QR now." });
});

app.get("/get-qr/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes[sessionId];
  
  if (!qr) {
      if (sessionStatus[sessionId] === "open") return res.send("Session already active!");
      return res.status(404).send("QR not generated yet.");
  }

  QRCode.toDataURL(qr).then(url => {
    const img = Buffer.from(url.split(",")[1], "base64");
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": img.length });
    res.end(img);
  });
});

app.post("/send-message", async (req, res) => {
    const { sessionId, phone, text } = req.body;
    const sock = sessions[sessionId];
    if (!sock) return res.status(400).json({error: "Session not found"});
    
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    
    // إرسال رسالة عادية (لن تسبب إيقاف البوت لأنها ليست ريبلاي)
    await sock.sendMessage(jid, { text: text });
    res.json({status: "sent"});
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
