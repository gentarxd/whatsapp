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

// ⚡ إنشاء أو تشغيل session جديد
async function startSock(sessionId) {
  const authFolder = `./auth_info/${sessionId}`;
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

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
      console.log(`QR generated for ${sessionId}`);
    }

    if (connection === "open") {
      sessionStatus[sessionId] = "open";
      console.log(`Session ${sessionId} connected`);
      delete qrCodes[sessionId];
    }

    if (connection === "close") {
      sessionStatus[sessionId] = "close";
      console.log(`Session ${sessionId} closed`);

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

// 🛡 Middleware للتحقق من API Key
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

// ✅ Get QR Code as image
app.get("/get-qr/:sessionId", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes[sessionId];

  if (!qr) return res.status(404).json({ error: "No QR available" });

  try {
    // تحويل الـ QR string لصورة PNG مباشرة
    const imgBuffer = await QRCode.toBuffer(qr, { type: "png" });

    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": imgBuffer.length,
    });
    res.end(imgBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/send-message", requireApiKey, async (req, res) => {
  const { sessionId, phone, text, imageUrl } = req.body;

  if (!sessionId || !phone) 
    return res.status(400).json({ error: "sessionId and phone required" });

  const sock = sessions[sessionId];
  if (!sock) 
    return res.status(400).json({ error: "Invalid session ID" });

  // نتأكد إن session مفتوح
  if (sessionStatus[sessionId] !== "open") {
    return res.status(400).json({ error: "Session not connected yet" });
  }

  try {
    const jid = `${phone}@s.whatsapp.net`;

    if (imageUrl) {
      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data, "binary");

      await sock.sendMessage(jid, { image: buffer, caption: text || "" });
    } else {
      await sock.sendMessage(jid, { text });
    }

    res.json({ status: "sent", phone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
