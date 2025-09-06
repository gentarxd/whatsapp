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

// إنشاء الـ WhatsApp socket
async function startSock(sessionId) {
  const authFolder = `./auth_info/${sessionId}`;
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
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

// ✅ Get QR Code as image or confirmation if scanned
app.get("/get-qr/:sessionId", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes[sessionId];

  if (!qr && sessionStatus[sessionId] === "open") {
    // QR تم مسحه بالفعل والـ session شغّال
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

// ✅ Send message and confirm session ID
app.post("/send-message", requireApiKey, async (req, res) => {
  const { sessionId, phone, text, imageUrl } = req.body;

  if (!sessionId || !phone) 
    return res.status(400).json({ error: "sessionId and phone required" });

  const sock = sessions[sessionId];
  if (!sock) 
    return res.status(400).json({ error: "Invalid session ID" });

  try {
    const jid = `${phone}@s.whatsapp.net`;

    if (imageUrl) {
      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data, "binary");

      await sock.sendMessage(jid, { image: buffer, caption: text || "" });
    } else {
      await sock.sendMessage(jid, { text });
    }

    res.json({ 
      status: "success", 
      message: "Session ID valid, message sent successfully", 
      phone 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Health check
app.get('/', (req, res) => {
  res.send('Server is running!');
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
