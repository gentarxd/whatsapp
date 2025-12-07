
  import express from "express";
  import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
  import axios from "axios";
  import fs from "fs";
  import QRCode from "qrcode";
  import { downloadMediaMessage } from "@whiskeysockets/baileys";
  import FormData from "form-data";
  import path from "path";
  import process from "process";

  // ---- Config from env
  const PROJECT_NAME = process.env.PROJECT_NAME || "whatsapp-bot";
  const PORT = process.env.PORT || 3000;
  const AUTH_DIR = process.env.AUTH_DIR || "./data/auth_info";
  const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://n8n.gentar.cloud/webhook/909d7c73-112a-455b-988c-9f770852c8fa";
  const PAUSE_MINUTES = parseInt(process.env.PAUSE_MINUTES || "60", 10);
  const PREFERRED_SESSION = process.env.PREFERRED_SESSION || "";

  // ---- Ensure data folders
  const DATA_DIR = "./data";
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (!fs.existsSync("./downloads")) fs.mkdirSync("./downloads", { recursive: true });

  // ---- simple disk persistence helpers
  function readJSON(file, fallback) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf8") || "null") || fallback;
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

  // ---- persisted state
  const OVERRIDES_FILE = path.join(DATA_DIR, "overrides.json");
  const QUEUE_FILE = path.join(DATA_DIR, "queue.json");

  const humanOverride = readJSON(OVERRIDES_FILE, {}); // { jid: pauseUntilMs }
  const messageQueue = readJSON(QUEUE_FILE, []); // array of { sessionId, phone, text, imageUrl, createdAt }

  const sessions = {};
  const qrCodes = {};
  const sessionStatus = {};
  const qrGenerationAttempts = {};

  const messageStatus = {}; // { phone: status }

  // ---- util
  function saveOverrides() { writeJSON(OVERRIDES_FILE, humanOverride); }
  function saveQueue() { writeJSON(QUEUE_FILE, messageQueue); }

  function canAutoReply(jid) {
    const pauseUntil = humanOverride[jid];
    if (!pauseUntil) return true;
    return Date.now() > pauseUntil;
  }

  // ---- WhatsApp socket starter
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
        if (sock?.ws?.readyState === 1) {
          sock.sendPresence("available");
        }
      } catch (e) {}
    }, 60 * 1000);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      try {
        const { connection, qr } = update;
        if (qr) {
          qrGenerationAttempts[sessionId] = (qrGenerationAttempts[sessionId] || 0) + 1;
          if (qrGenerationAttempts[sessionId] > 5) {
            sessionStatus[sessionId] = "qr_limit_reached";
            return;
          }
          qrCodes[sessionId] = qr;
          sessionStatus[sessionId] = "qr";
          console.log(`[${PROJECT_NAME}] QR generated for ${sessionId} (attempt ${qrGenerationAttempts[sessionId]})`);
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
          setTimeout(() => startSock(sessionId).catch(e => console.error(e)), 3000);
        }
      } catch (e) {
        console.error("connection.update error", e?.message || e);
      }
    });
sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    // تجاهل رسائل البوت نفسه
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const isFromMe = msg.key.fromMe === true;

    // لو انت اللي رديت على العميل -> Pause
    if (isFromMe) {
        pauseUntil[from] = Date.now() + PAUSE_MINUTES * 60 * 1000;
        savePauseState();
        console.log(`[BOT PAUSED] User manually replied to ${from}`);
        return;
    }

    // لو فيه Pause شغال للعميل -> تجاهل
    if (pauseUntil[from] && Date.now() < pauseUntil[from]) {
        const remaining = new Date(pauseUntil[from]).toISOString();
        console.log(`[AUTO-PAUSE] Still paused for ${from} until ${remaining}`);
        return;
    }

    // لو العميل بعت رسالة -> البوت يرد
    await sock.sendMessage(from, { text: AUTO_REPLY_TEXT });

    // البوت ما يفعّلش Pause هنا لأن الرد ده Bot reply مش manual
    console.log(`[BOT REPLIED] Auto reply sent to ${from}`);
});


        // extract text/media
        let text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption ||
          msg.message.audioMessage?.caption ||
          "";

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

        // build webhook payload and send to configured webhook
        try {
          const form = new FormData();
          form.append("sessionId", sessionId);
          form.append("from", from);
          form.append("senderPn", senderPn);
          form.append("type", type);
          form.append("text", text || "");
          form.append("mediaType", mediaType || "");
          form.append("mimeType", mimeType || "");
          form.append("fileName", fileName || "");
          form.append("raw", JSON.stringify(msg));
          if (mediaBuffer) form.append("file", mediaBuffer, { filename: fileName, contentType: mimeType });
          await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders(), timeout: 20000 });
          console.log(`[${PROJECT_NAME}] Message forwarded to webhook`);
        } catch (e) {
          console.error(`[${PROJECT_NAME}] Error forwarding to webhook:`, e?.message || e);
        }

      } catch (e) {
        console.error("messages.upsert error", e?.message || e);
      }
    });

    sessions[sessionId] = sock;
    return sock;
  }

  // ---- simple reconnect existing sessions on boot
  function reconnectSessions() {
    try {
      if (fs.existsSync(AUTH_DIR)) {
        let sessionFolders = fs.readdirSync(AUTH_DIR).filter(x => fs.statSync(path.join(AUTH_DIR, x)).isDirectory());
        if (PREFERRED_SESSION) {
          sessionFolders = sessionFolders.filter(s => s !== PREFERRED_SESSION);
          sessionFolders.unshift(PREFERRED_SESSION);
        }
        console.log(`[${PROJECT_NAME}] Found ${sessionFolders.length} session(s) to reconnect.`);
        sessionFolders.forEach(sessionId => {
          startSock(sessionId).catch(e => console.error("reconnect error", e?.message || e));
        });
      } else {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }
    } catch (e) {
      console.error("reconnectSessions error", e?.message || e);
    }
  }

  // ---- Express server & routes
  const app = express();
  app.use(express.json());

  app.get("/", (req, res) => res.send(`${PROJECT_NAME} running`));

  app.post("/create-session", async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ error: "sessionId required" });
      await startSock(sessionId);
      res.json({ message: "session created", sessionId });
    } catch (e) { console.error(e); res.status(500).json({ error: "failed to create session" }); }
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

  app.post("/check", async (req, res) => {
    try {
      const { sessionId, numbers } = req.body;
      if (!sessionId || !Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: "sessionId and numbers[] required" });
      const sock = sessions[sessionId];
      if (!sock) return res.status(404).json({ error: "session not found" });
      const jids = numbers.map(n => `${n}@s.whatsapp.net`);
      const results = await sock.onWhatsApp(jids);
      const formatted = numbers.map(num => {
        const jid = `${num}@s.whatsapp.net`;
        const found = results.find(r => r.jid === jid);
        return { number: num, exists: !!found?.exists };
      });
      res.json({ sessionId, results: formatted });
    } catch (e) { console.error(e); res.status(500).json({ error: "failed to check numbers" }); }
  });

  app.post("/send-message", (req, res) => {
    try {
      const { sessionId, phone, text, imageUrl } = req.body;
      if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });
      const item = { sessionId, phone, text: text || "", imageUrl: imageUrl || "", createdAt: Date.now() };
      messageQueue.push(item);
      saveQueue();
      messageStatus[phone] = "queued";
      res.json({ status: "queued", phone });
    } catch (e) { console.error(e); res.status(500).json({ error: "failed to queue message" }); }
  });

  app.get("/message-status", (req, res) => res.json(messageStatus));

  app.get("/status/:sessionId", (req, res) => res.json({ sessionId: req.params.sessionId, status: sessionStatus[req.params.sessionId] || "not_found" }));

  // resume override manually
  app.post("/resume/:jid", (req, res) => {
    const { jid } = req.params;
    if (humanOverride[jid]) {
      delete humanOverride[jid];
      saveOverrides();
    }
    res.json({ status: "resumed", for: jid });
  });

  // ---- Queue processor
  const PROCESS_INTERVAL_MS = 2000;
  async function processQueueItem(item) {
    const { sessionId, phone, text, imageUrl } = item;
    const sock = sessions[sessionId];
    if (!sock) {
      messageStatus[phone] = "no_session";
      return;
    }
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    if (!canAutoReply(jid)) {
      messageStatus[phone] = "paused";
      return;
    }
    try {
      if (imageUrl) {
        const response = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 60000 });
        const buffer = Buffer.from(response.data, "binary");
        await sock.sendMessage(jid, { image: buffer, caption: text || "" });
      } else {
        await sock.sendMessage(jid, { text: text || " " });
      }
      messageStatus[phone] = "sent";
    } catch (e) {
      console.error("processQueueItem error", e?.message || e);
      messageStatus[phone] = "error";
    }
  }

  setInterval(async () => {
    if (messageQueue.length === 0) return;
    const item = messageQueue.shift();
    try {
      await processQueueItem(item);
    } catch (e) { console.error(e); }
    saveQueue();
  }, PROCESS_INTERVAL_MS);

  // ---- startup
  reconnectSessions();
  app.listen(PORT, () => console.log(`[${PROJECT_NAME}] Server running on port ${PORT}`));

  // graceful shutdown
  process.on("SIGINT", () => {
    console.log("SIGINT: saving state and exiting...");
    saveOverrides();
    saveQueue();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    console.log("SIGTERM: saving state and exiting...");
    saveOverrides();
    saveQueue();
    process.exit(0);
  });
