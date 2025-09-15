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

// Base path for storing sessions (persistent in Render)
const baseAuthPath = process.env.SESSION_DIR || "./auth_info";

// --- Helper: API key check ---
function requireApiKey(req, res, next) {
  if (API_KEY) {
    const header = req.headers["x-api-key"];
    if (header !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// --- Start socket ---
async function startSock(sessionId) {
  const authFolder = `${baseAuthPath}/${sessionId}`;
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

// --- API Routes ---

// ✅ Create new session (always generates QR if new)
app.post("/create-session", requireApiKey, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  await startSock(sessionId);
  res.json({ message: "Session created (scan QR if required)", sessionId });
});

// ✅ Connect existing session (reuse saved creds)
app.post("/connect-session", requireApiKey, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (sessions[sessionId]) {
    return res.json({ message: "Session already active", sessionId });
  }

  await startSock(sessionId);
  res.json({ message: "Session connected (or QR needed if expired)", sessionId });
});

// ✅ Get QR code
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

// ✅ Check session status
app.get("/session-status/:sessionId", requireApiKey, (req, res) => {
  const { sessionId } = req.params;
  const status = sessionStatus[sessionId] || "not found";
  res.json({ sessionId, status });
});

// ✅ Delete session
app.delete("/delete-session/:sessionId", requireApiKey, (req, res) => {
  const { sessionId } = req.params;

  if (sessions[sessionId]) {
    delete sessions[sessionId];
  }

  const authFolder = `${baseAuthPath}/${sessionId}`;
  if (fs.existsSync(authFolder)) {
    fs.rmSync(authFolder, { recursive: true, force: true });
  }

  delete qrCodes[sessionId];
  delete sessionStatus[sessionId];

  res.json({ message: "Session deleted", sessionId });
});

// ✅ Send message
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
      message: "Message sent successfully", 
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