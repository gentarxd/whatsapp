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

// ---- Ensure folders
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync("./downloads")) fs.mkdirSync("./downloads", { recursive: true });

// ---- Persistence helpers
function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8") || "null") || fallback;
  } catch (e) { console.error("readJSON error", file, e?.message || e); }
  return fallback;
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("writeJSON error", file, e?.message || e); }
}

// ---- State
const PAUSE_FILE = path.join(DATA_DIR, "pause.json");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");

const pauseUntil = readJSON(PAUSE_FILE, {}); // { jid: timestamp }
const messageQueue = readJSON(QUEUE_FILE, []); // array of { sessionId, phone, text, imageUrl, createdAt }

const sessions = {};
const qrCodes = {};
const sessionStatus = {};
const qrGenerationAttempts = {};
const messageStatus = {}; // { phone: { status, source } }

// ---- Utils
function saveQueue() { writeJSON(QUEUE_FILE, messageQueue); }
function savePauseFile() { writeJSON(PAUSE_FILE, pauseUntil); }
function canAutoReply(jid) { return !pauseUntil[jid] || Date.now() > pauseUntil[jid]; }

// ---- Extract senderPN
function getSenderPN(msg) {
  // لو فيه participant (جروب)
  if (msg.key.participant) return msg.key.participant.split("@")[0];

  // لو فيه senderPn مباشر (اللي فيه @s.whatsapp.net)
  if (msg.key.senderPn) return msg.key.senderPn.split("@")[0];

  // fallback على remoteJid لو فردي
  if (msg.key.remoteJid && msg.key.remoteJid.includes("@s.whatsapp.net")) return msg.key.remoteJid.split("@")[0];

  // fallback نهائي لأي حالة تانية
  return msg.key.remoteJid ? msg.key.remoteJid.split("@")[0] : null;
}


// ---- Handle incoming message
async function handleMessage(msg) {
  const now = Date.now();
  const from = msg.key.remoteJid;
  const senderPN = getSenderPN(msg);

  const textMsg =
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    msg?.message?.documentMessage?.caption ||
    msg?.message?.audioMessage?.caption ||
    "";

  // Detect human reply
  const isReply = !!msg?.message?.extendedTextMessage?.contextInfo?.stanzaId;

  if (isReply) {
    pauseUntil[from] = now + PAUSE_MINUTES * 60 * 1000;
    savePauseFile();
    console.log(`[${PROJECT_NAME}] Paused auto-reply for ${from} due to human reply`);
    return;
  }

  if (pauseUntil[from] && pauseUntil[from] > now) {
    console.log(`[${PROJECT_NAME}] Auto-reply paused for ${from} until ${new Date(pauseUntil[from]).toISOString()}`);
    return;
  } else if (pauseUntil[from] && pauseUntil[from] <= now) {
    delete pauseUntil[from];
    savePauseFile();
    console.log(`[${PROJECT_NAME}] Auto-reply resumed for ${from}`);
  }

  // Forward to n8n
  const payload = { from, senderPN, text: textMsg, timestamp: now };
  try {
    await axios.post(WEBHOOK_URL, payload);
    console.log(`[${PROJECT_NAME}] Forwarded message from ${senderPN} to n8n`);
  } catch (err) {
    console.error(`[${PROJECT_NAME}] Failed to forward to n8n:`, err.message);
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
    try { if (sock?.ws?.readyState === 1) sock.sendPresence("available"); } catch (e) {}
  }, 60 * 1000);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;
    if (qr) {
      qrGenerationAttempts[sessionId] = (qrGenerationAttempts[sessionId] || 0) + 1;
      qrCodes[sessionId] = qr;
      sessionStatus[sessionId] = "qr";
      console.log(`[${PROJECT_NAME}] QR generated for ${sessionId}`);
    }
    if (connection === "open") {
      sessionStatus[sessionId] = "open";
      delete qrCodes[sessionId];
      qrGenerationAttempts[sessionId] = 0;
      console.log(`[${PROJECT_NAME}] Session ${sessionId} open`);
    }
    if (connection === "close") {
      sessionStatus[sessionId] = "close";
      clearInterval(pingInterval);
      delete sessions[sessionId];
      console.log(`[${PROJECT_NAME}] Session ${sessionId} closed — reconnecting in 3s...`);
      setTimeout(() => startSock(sessionId).catch(console.error), 3000);
    }
  });

  // ---- Listen for incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const senderPN = getSenderPN(msg);
    const type = Object.keys(msg.message)[0];

    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      msg.message.audioMessage?.caption ||
      null;

    // ---- Download media
    let mediaBuffer = null, fileName = null, mimeType = null;
    if (msg.message.imageMessage) {
      mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
      fileName = "image.jpg";
      mimeType = msg.message.imageMessage.mimetype;
    } else if (msg.message.videoMessage) {
      mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
      fileName = "video.mp4";
      mimeType = msg.message.videoMessage.mimetype;
    } else if (msg.message.documentMessage) {
      mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
      fileName = msg.message.documentMessage.fileName || "document";
      mimeType = msg.message.documentMessage.mimetype;
    } else if (msg.message.audioMessage) {
      mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: null });
      fileName = "audio.mp3";
      mimeType = msg.message.audioMessage.mimetype;
    }

    // ---- Forward to webhook
    const form = new FormData();
    form.append("sessionId", sessionId);
    form.append("from", from);
    form.append("senderPN", senderPN);
    form.append("type", type);
    form.append("text", text || "");
    form.append("raw", JSON.stringify(msg));
    if (mediaBuffer) form.append("file", mediaBuffer, { filename: fileName, contentType: mimeType });

    try {
      await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders(), timeout: 20000 });
      console.log(`[${PROJECT_NAME}] Message forwarded from ${senderPN}`);
    } catch (err) {
      console.error(`[${PROJECT_NAME}] Failed to forward message:`, err.message);
    }
  });

  sessions[sessionId] = sock;
  return sock;
}

// ---- Express server
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send(`${PROJECT_NAME} running`));

app.post("/create-session", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try { await startSock(sessionId); res.json({ message: "session created", sessionId }); }
  catch (e) { console.error(e); res.status(500).json({ error: "failed to create session" }); }
});

app.get("/get-qr/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes[sessionId];
  if (!qr && sessionStatus[sessionId] === "open") return res.json({ status: "success", message: "QR already scanned, session active" });
  if (!qr) return res.status(404).json({ error: "No QR available" });
  QRCode.toDataURL(qr).then(qrImage => {
    const img = Buffer.from(qrImage.split(",")[1], "base64");
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": img.length });
    res.end(img);
  }).catch(e => res.status(500).json({ error: "failed to generate qr" }));
});

// ----------------------
// Send-message endpoint
// ----------------------
app.post("/send-message", async (req, res) => {
  try {
    const { sessionId, phone, text, imageUrl } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });

    messageQueue.push({ sessionId, phone, text, imageUrl, createdAt: Date.now() });
    messageStatus[phone] = { status: "queued" };
    console.log(`[queue] Added message for ${phone}. Queue length: ${messageQueue.length}`);

    res.json({ status: "queued", phone });
  } catch (err) {
    console.error("/send-message error:", err?.message || err);
    res.status(500).json({ error: "failed to queue message" });
  }
});

// ----------------------
// Queue Processor
// ----------------------
setInterval(async () => {
  if (!messageQueue.length) return;

  const { sessionId, phone, text, imageUrl } = messageQueue.shift();
  const sock = sessions[sessionId];
  if (!sock) { messageStatus[phone] = { status: "no_session" }; return; }

  const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

  try {
    if (imageUrl) {
      const response = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 60000 });
      const buffer = Buffer.from(response.data, "binary");
      await sock.sendMessage(jid, { image: buffer, caption: text || "" });
      console.log(`[queue] Sent image to ${jid}`);
    } else {
      await sock.sendMessage(jid, { text: text || " " });
      console.log(`[queue] Sent text to ${jid}`);
    }
    messageStatus[phone] = { status: "sent" };
  } catch (err) {
    console.error(`[queue] Error sending message to ${jid}:`, err?.message || err);
    messageStatus[phone] = { status: "error" };
  }
}, 2000);

// ---- Pause endpoint
app.post("/pause/:jid", (req, res) => {
  const { jid } = req.params;
  pauseUntil[jid] = Date.now() + PAUSE_MINUTES * 60 * 1000;
  savePauseFile();
  res.json({ status: "paused", until: new Date(pauseUntil[jid]).toISOString() });
});

// ---- Reconnect all sessions on startup
const sessionFolders = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR).filter(x => fs.statSync(path.join(AUTH_DIR, x)).isDirectory()) : [];
console.log(`[${PROJECT_NAME}] Found ${sessionFolders.length} session(s) to reconnect.`);
sessionFolders.forEach(sessionId => startSock(sessionId).catch(console.error));

app.listen(PORT, () => console.log(`[${PROJECT_NAME}] Server running on port ${PORT}`));
