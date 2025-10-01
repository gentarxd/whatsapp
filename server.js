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
    });

    // ✅ Keep-Alive Ping
    const pingInterval = setInterval(() => {
      if (sock?.ws?.readyState === 1) {
        sock.sendPresenceUpdate("available");
        console.log(`📡 KeepAlive ping sent for ${sessionId}`);
      }
    }, 60 * 1000);

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

          const shouldReconnect =
            (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect) {
            const target = preferredSessionId || sessionId;
            console.log(`🔄 Will attempt reconnect to "${target}" in 5s...`);

            try { delete sessions[sessionId]; } catch (e) { /* ignore */ }

            setTimeout(() => {
              startSock(target).catch(e =>
                console.error(`Reconnection error for ${target}:`, e?.message || e)
              );
            }, 5000);
          } else {
            sessionStatus[sessionId] = "logged_out";
            console.log(`Session ${sessionId} logged out. تحتاج QR جديد`);
            clearInterval(pingInterval); // وقف الـ KeepAlive لما يخرج نهائي
          }
        }
      } catch (e) {
        console.error(`Error in connection.update handler for ${sessionId}:`, e?.message || e);
      }
    });

    // ✅ LISTENER للرسائل الجديدة
    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          null;

        console.log(`💬 New message from ${from}: ${text}`);

        // ابعت للـ webhook بتاع n8n
        await axios.post(
          "https://n8n-latest-znpr.onrender.com/webhook/909d7c73-112a-455b-988c-9f770852c8fa",
          {
            sessionId,
            from,
            text,
            raw: msg
          },
          { timeout: 10000 }
        );
      } catch (err) {
        console.error("❌ Error sending to n8n webhook:", err?.message || err);
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
// Middleware for API key
// =======================
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

app.post("/check", requireApiKey, async (req, res) => {
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

app.post("/link-number", requireApiKey, async (req, res) => {
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

app.post("/set-preferred-session", requireApiKey, (req, res) => {
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

app.post("/send-message", requireApiKey, async (req, res) => {
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
            const response = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 60000 });
            let buffer = Buffer.from(response.data, "binary");
            await sock.sendMessage(jid, { image: buffer, caption: text || "", jpegThumbnail: null });
            console.log(`[queue] Sent image (attempt ${attempt}) to ${phone}`);
          } else {
            await sock.sendMessage(jid, { text: text || " " });
            console.log(`[queue] Sent text fallback to ${phone}`);
          }
          messageStatus[phone] = "sent";
          sent = true;
          break;
        } catch (err) {
          console.error(`[queue] Error attempt ${attempt} for ${phone}:`, err?.message || err);
          if ((err?.message || "").toLowerCase().includes("connection closed")) {
            console.log(`[queue] Detected Connection Closed while sending to ${phone}. Will try reconnect.`);
            try { delete sessions[sessionId]; } catch(e){}
            const target = preferredSessionId || sessionId;
            setTimeout(() => startSock(target).catch(e => console.error(`Reconnection error for ${target}:`, e?.message || e)), 3000);
          }
        }
      }
      if (!sent) {
        messageStatus[phone] = "error";
        console.error(`[queue] All attempts failed for ${phone}`);
      }
    } else {
      await sock.sendMessage(jid, { text });
      console.log(`[queue] Sent text to ${phone}`);
      messageStatus[phone] = "sent";
    }
  } catch (err) {
    console.error(`[queue] Fatal error sending to ${phone}:`, err?.message || err);
    messageStatus[phone] = "error";
  }
}, 2000);

app.get("/message-status", requireApiKey, (req, res) => {
  try { res.json(messageStatus); }
  catch (err) { console.error("/message-status error:", err?.message || err); res.status(500).json({ error: "failed to get message status" }); }
});

app.get("/status/:sessionId", requireApiKey, (req, res) => {
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
