import express from "express";
import makeWASocket, { useMultiFileAuthState, downloadMediaMessage } from "@whiskeysockets/baileys";
import axios from "axios";
import fs from "fs";
import QRCode from "qrcode";
import FormData from "form-data";
import path from "path";
import process from "process";

// ---- Config
const PROJECT_NAME = process.env.PROJECT_NAME || "whatsapp-bot";
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || "./data/auth_info";
const DATA_DIR = "./data";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://n8n.gentar.cloud/webhook/909d7c73-112a-455b-988c-9f770852c8fa";
const PAUSE_MINUTES = parseInt(process.env.PAUSE_MINUTES || "60", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);

// ---- Ensure folders
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync("./downloads")) fs.mkdirSync("./downloads", { recursive: true });

// ---- Persistence helpers
function readJSON(file, fallback) {
  try { 
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      return JSON.parse(content || "null") || fallback;
    }
  } catch (e) { 
    console.error("readJSON error", file, e?.message || e); 
  }
  return fallback;
}

function writeJSON(file, data) {
  try { 
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); 
  } catch (e) { 
    console.error("writeJSON error", file, e?.message || e); 
  }
}

// ---- State
const PAUSE_FILE = path.join(DATA_DIR, "pause.json");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");

const pauseUntil = readJSON(PAUSE_FILE, {});
const messageQueue = readJSON(QUEUE_FILE, []);

const sessions = {};
const qrCodes = {};
const sessionStatus = {};
const qrGenerationAttempts = {};
const messageStatus = {};
const sentMessageIds = new Set();

// ---- Utils
function saveQueue() { writeJSON(QUEUE_FILE, messageQueue); }
function savePauseFile() { writeJSON(PAUSE_FILE, pauseUntil); }

function cleanupMessageStatus() {
  const oneHourAgo = Date.now() - 3600000;
  Object.keys(messageStatus).forEach(phone => {
    if (messageStatus[phone].timestamp < oneHourAgo) {
      delete messageStatus[phone];
    }
  });
  
  if (sentMessageIds.size > 1000) {
    const arr = Array.from(sentMessageIds);
    arr.slice(0, arr.length - 1000).forEach(id => sentMessageIds.delete(id));
  }
}
setInterval(cleanupMessageStatus, 300000);

function normalizePhone(phone) {
  return phone ? phone.split("@")[0] : "";
}

function getBotNumber(sock) {
  try {
    const botJid = sock?.user?.id;
    return botJid ? normalizePhone(botJid) : null;
  } catch (e) {
    console.error("Failed to get bot number:", e.message);
    return null;
  }
}

// ---- WhatsApp socket
async function startSock(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  if (sessions[sessionId]) return sessions[sessionId];

  const authFolder = path.join(AUTH_DIR, sessionId);
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
  });

  const pingInterval = setInterval(() => {
    try { 
      if (sock?.ws?.readyState === 1) sock.sendPresence("available"); 
    } catch (e) {
      // ignore
    }
  }, 60 * 1000);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;
    
    if (qr) {
      qrGenerationAttempts[sessionId] = (qrGenerationAttempts[sessionId] || 0) + 1;
      qrCodes[sessionId] = qr;
      sessionStatus[sessionId] = "qr";
      console.log(`[${PROJECT_NAME}] QR generated for ${sessionId} (attempt ${qrGenerationAttempts[sessionId]})`);
    }
    
    if (connection === "open") {
      sessionStatus[sessionId] = "open";
      delete qrCodes[sessionId];
      qrGenerationAttempts[sessionId] = 0;
      const botNumber = getBotNumber(sock);
      console.log(`[${PROJECT_NAME}] Session ${sessionId} open (Bot: ${botNumber})`);
    }
    
    if (connection === "close") {
      sessionStatus[sessionId] = "close";
      clearInterval(pingInterval);
      delete sessions[sessionId];
      console.log(`[${PROJECT_NAME}] Session ${sessionId} closed — reconnecting in 3s...`);
      setTimeout(() => startSock(sessionId).catch(console.error), 3000);
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const fromMe = !!msg.key.fromMe;
    const messageId = msg.key.id;
    let from, senderPN;

    const BOT_NUMBER = getBotNumber(sock);
    if (!BOT_NUMBER) {
      console.error("[webhook] Could not determine bot number");
      return;
    }

    if (fromMe) {
      senderPN = BOT_NUMBER;
      const isReply = !!msg.message?.extendedTextMessage?.contextInfo;
      if (isReply && msg.message.extendedTextMessage.contextInfo?.participant) {
        from = msg.message.extendedTextMessage.contextInfo.participant;
      } else {
        from = msg.key.remoteJid;
      }
    } else {
      from = msg.key.remoteJid;
      senderPN = msg.key.participant?.split("@")[0] || 
                 msg.key.remoteJid?.split("@")[0] || 
                 null;
    }

    if (msg.message.protocolMessage || from === "status@broadcast") return;

    const cleanFrom = normalizePhone(from);
    const cleanSenderPN = normalizePhone(senderPN);

    if (pauseUntil[cleanFrom] && Date.now() < pauseUntil[cleanFrom]) {
      console.log(`[${PROJECT_NAME}] Bot paused for ${cleanFrom} until ${new Date(pauseUntil[cleanFrom]).toISOString()}`);
      return;
    }

    if (fromMe) {
      const isManualReply = msg.message?.extendedTextMessage?.contextInfo && 
                           !sentMessageIds.has(messageId);
      
      if (isManualReply) {
        let pauseTarget = msg.message.extendedTextMessage.contextInfo?.participant || msg.key.remoteJid;
        pauseTarget = normalizePhone(pauseTarget);

        pauseUntil[pauseTarget] = Date.now() + PAUSE_MINUTES * 60 * 1000;
        savePauseFile();
        console.log(`[${PROJECT_NAME}] Paused bot for ${pauseTarget} for ${PAUSE_MINUTES} minutes (manual reply detected)`);
        return;
      }
      
      sentMessageIds.delete(messageId);
    }

    let text = "";
    if (msg.message?.conversation) {
      text = msg.message.conversation;
    } else if (msg.message?.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
    } else if (msg.message?.imageMessage?.caption) {
      text = msg.message.imageMessage.caption;
    } else if (msg.message?.videoMessage?.caption) {
      text = msg.message.videoMessage.caption;
    } else if (msg.message?.documentMessage?.caption) {
      text = msg.message.documentMessage.caption;
    } else if (msg.message?.buttonsResponseMessage?.selectedButtonId) {
      text = msg.message.buttonsResponseMessage.selectedButtonId;
    } else if (msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
      text = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
    }

    let mediaBuffer = null, fileName = null, mimeType = null;
    try {
      if (msg.message.imageMessage) {
        mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
        fileName = "image.jpg";
        mimeType = msg.message.imageMessage.mimetype || "image/jpeg";
      } else if (msg.message.videoMessage) {
        mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
        fileName = "video.mp4";
        mimeType = msg.message.videoMessage.mimetype || "video/mp4";
      } else if (msg.message.documentMessage) {
        mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
        fileName = msg.message.documentMessage.fileName || "document";
        mimeType = msg.message.documentMessage.mimetype || "application/octet-stream";
      } else if (msg.message.audioMessage) {
        mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
        fileName = "audio.mp3";
        mimeType = msg.message.audioMessage.mimetype || "audio/mpeg";
      }
    } catch (e) {
      console.error("[webhook] Media download failed:", e.message);
    }

    if (!text && !mediaBuffer) {
      console.log("[webhook] Ignored empty message");
      return;
    }

    const form = new FormData();
    form.append("sessionId", String(sessionId));
    form.append("from", String(from || ""));
    form.append("senderPN", String(cleanSenderPN || ""));
    form.append("fromMe", String(fromMe));
    form.append("text", String(text || ""));
    form.append("type", String(msg.message?.extendedTextMessage ? "extendedTextMessage" : "message"));
    form.append("messageId", String(messageId || ""));
    form.append("timestamp", String(msg.messageTimestamp || Date.now()));

    if (mediaBuffer && mimeType) {
      form.append("file", mediaBuffer, { filename: fileName, contentType: mimeType });
    }

    try {
      await axios.post(WEBHOOK_URL, form, {
        headers: form.getHeaders(),
        timeout: 20000
      });
      console.log(`[${PROJECT_NAME}] Forwarded message from ${cleanSenderPN} to webhook`);
    } catch (err) {
      console.error(`[${PROJECT_NAME}] Webhook failed:`, err.message);
    }

    if (pauseUntil[cleanFrom] && Date.now() >= pauseUntil[cleanFrom]) {
      delete pauseUntil[cleanFrom];
      savePauseFile();
      console.log(`[${PROJECT_NAME}] Pause expired for ${cleanFrom}`);
    }
  });

  sessions[sessionId] = sock;
  return sock;
}

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ 
    service: PROJECT_NAME, 
    status: "running",
    sessions: Object.keys(sessions).length,
    queueLength: messageQueue.length,
    pausedContacts: Object.keys(pauseUntil).length
  });
});

app.post("/create-session", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  
  try { 
    await startSock(sessionId); 
    res.json({ 
      message: "session created", 
      sessionId,
      status: sessionStatus[sessionId] || "initializing"
    }); 
  } catch (e) { 
    console.error(e); 
    res.status(500).json({ error: "failed to create session", details: e.message }); 
  }
});

app.get("/session-status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const status = sessionStatus[sessionId] || "not_found";
  const hasQR = !!qrCodes[sessionId];
  
  res.json({ 
    sessionId, 
    status,
    hasQR,
    qrAttempts: qrGenerationAttempts[sessionId] || 0
  });
});

app.get("/get-qr/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes[sessionId];
  
  if (!qr && sessionStatus[sessionId] === "open") {
    return res.json({ status: "success", message: "QR already scanned, session active" });
  }
  
  if (!qr) {
    return res.status(404).json({ error: "No QR available" });
  }
  
  QRCode.toDataURL(qr)
    .then(qrImage => {
      const img = Buffer.from(qrImage.split(",")[1], "base64");
      res.writeHead(200, { 
        "Content-Type": "image/png", 
        "Content-Length": img.length 
      });
      res.end(img);
    })
    .catch(e => res.status(500).json({ error: "failed to generate qr", details: e.message }));
});

app.post("/send-message", async (req, res) => {
  try {
    const { sessionId, phone, text, imageUrl } = req.body;
    
    if (!sessionId || !phone) {
      return res.status(400).json({ error: "sessionId and phone required" });
    }

    const normalizedPhone = normalizePhone(phone);
    
    messageQueue.push({ 
      sessionId, 
      phone: normalizedPhone, 
      text, 
      imageUrl, 
      createdAt: Date.now(),
      retries: 0
    });
    
    messageStatus[normalizedPhone] = { 
      status: "queued", 
      timestamp: Date.now() 
    };
    
    saveQueue();
    
    console.log(`[queue] Added message for ${normalizedPhone}. Queue length: ${messageQueue.length}`);
    res.json({ status: "queued", phone: normalizedPhone, queuePosition: messageQueue.length });
    
  } catch (err) {
    console.error("/send-message error:", err?.message || err);
    res.status(500).json({ error: "failed to queue message", details: err.message });
  }
});

app.get("/message-status/:phone", (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const status = messageStatus[phone] || { status: "unknown" };
  res.json({ phone, ...status });
});

app.get("/queue-status", (req, res) => {
  res.json({
    queueLength: messageQueue.length,
    messages: messageQueue.map(m => ({
      phone: m.phone,
      createdAt: m.createdAt,
      retries: m.retries,
      age: Date.now() - m.createdAt
    }))
  });
});

app.get("/paused-contacts", (req, res) => {
  const now = Date.now();
  const paused = Object.entries(pauseUntil)
    .filter(([_, time]) => time > now)
    .map(([phone, time]) => ({
      phone,
      pausedUntil: new Date(time).toISOString(),
      remainingMinutes: Math.ceil((time - now) / 60000)
    }));
  
  res.json({ pausedContacts: paused });
});

app.post("/unpause/:phone", (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (pauseUntil[phone]) {
    delete pauseUntil[phone];
    savePauseFile();
    res.json({ message: `Unpaused bot for ${phone}` });
  } else {
    res.json({ message: `Bot was not paused for ${phone}` });
  }
});

setInterval(async () => {
  if (!messageQueue.length) return;

  const item = messageQueue[0];
  const { sessionId, phone, text, imageUrl, retries = 0 } = item;
  const now = Date.now();

  if (pauseUntil[phone] && pauseUntil[phone] > now) {
    console.log(`[queue] Skipping ${phone}, paused until ${new Date(pauseUntil[phone]).toISOString()}`);
    return;
  }

  messageQueue.shift();
  saveQueue();

  const sock = sessions[sessionId];
  
  if (!sock) {
    console.error(`[queue] No active session for ${sessionId}`);
    messageStatus[phone] = { status: "no_session", timestamp: now };
    
    if (retries < MAX_RETRIES) {
      item.retries = retries + 1;
      messageQueue.push(item);
      saveQueue();
      console.log(`[queue] Re-queued message for ${phone} (retry ${item.retries}/${MAX_RETRIES})`);
    }
    return;
  }

  const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

  try {
    let sentMsg;
    
    if (imageUrl) {
      const response = await axios.get(imageUrl, { 
        responseType: "arraybuffer", 
        timeout: 60000 
      });
      const buffer = Buffer.from(response.data, "binary");
      sentMsg = await sock.sendMessage(jid, { image: buffer, caption: text || "" });
      console.log(`[queue] Sent image to ${jid}`);
    } else {
      sentMsg = await sock.sendMessage(jid, { text: text || " " });
      console.log(`[queue] Sent text to ${jid}`);
    }
    
    if (sentMsg?.key?.id) {
      sentMessageIds.add(sentMsg.key.id);
    }
    
    messageStatus[phone] = { status: "sent", timestamp: now };
    
  } catch (err) {
    console.error(`[queue] Error sending to ${jid}:`, err?.message || err);
    messageStatus[phone] = { status: "error", timestamp: now, error: err.message };
    
    if (retries < MAX_RETRIES) {
      item.retries = retries + 1;
      messageQueue.push(item);
      saveQueue();
      console.log(`[queue] Re-queued message for ${phone} (retry ${item.retries}/${MAX_RETRIES})`);
    }
  }
}, 2000);

const sessionFolders = fs.existsSync(AUTH_DIR) 
  ? fs.readdirSync(AUTH_DIR).filter(x => fs.statSync(path.join(AUTH_DIR, x)).isDirectory()) 
  : [];

console.log(`[${PROJECT_NAME}] Found ${sessionFolders.length} session(s) to reconnect.`);
sessionFolders.forEach(sessionId => startSock(sessionId).catch(console.error));

process.on("SIGINT", () => {
  console.log(`[${PROJECT_NAME}] Shutting down gracefully...`);
  saveQueue();
  savePauseFile();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log(`[${PROJECT_NAME}] Shutting down gracefully...`);
  saveQueue();
  savePauseFile();
  process.exit(0);
});

app.listen(PORT, () => console.log(`[${PROJECT_NAME}] Server running on port ${PORT}`));
