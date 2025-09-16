import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import axios from "axios";

const app = express();
app.use(express.json());

const sessions = {};
const DISK_PATH = process.env.SESSION_PATH || "./sessions";

// ✅ Restore all saved sessions on start
async function restoreSessions() {
  if (!fs.existsSync(DISK_PATH)) return;
  const sessionDirs = fs.readdirSync(DISK_PATH);
  for (const sessionId of sessionDirs) {
    console.log("🔄 Restoring session:", sessionId);
    await connectToWhatsApp(sessionId);
  }
}

// ✅ Connect to WhatsApp
async function connectToWhatsApp(sessionId) {
  const authFolder = path.join(DISK_PATH, sessionId);
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`🔑 QR generated for ${sessionId}`);
      sessions[sessionId].qr = qr;
    }

    if (connection === "open") {
      console.log(`✅ Session ${sessionId} connected`);
      sessions[sessionId].sock = sock;
      sessions[sessionId].connected = true;
      sessions[sessionId].qr = null;
    } else if (connection === "close") {
      console.log(`❌ Session ${sessionId} closed`);
      sessions[sessionId].connected = false;

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`🔄 Reconnecting ${sessionId}...`);
        connectToWhatsApp(sessionId);
      }
    }
  });

  if (!sessions[sessionId]) {
    sessions[sessionId] = {};
  }

  sessions[sessionId] = {
    ...sessions[sessionId],
    sock,
    connected: sessions[sessionId].connected || false,
    qr: sessions[sessionId].qr || null,
  };

  return sock;
}

// ✅ Create or reconnect session
app.post("/connect", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  if (!sessions[sessionId]) {
    sessions[sessionId] = { connected: false, qr: null };
  }

  if (!sessions[sessionId].connected) {
    connectToWhatsApp(sessionId);
  }

  res.json({ message: `Session ${sessionId} is being initialized/connected.` });
});

// ✅ Get session status
app.get("/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  if (!session.connected) {
    console.log(`⚡ Auto-reconnecting ${sessionId} because it's not connected`);
    connectToWhatsApp(sessionId);
  }

  res.json({
    sessionId,
    connected: session.connected || false,
    qr: session.qr ? true : false,
  });
});

// ✅ Get QR as PNG
app.get("/get-qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  if (!session.qr && session.connected) {
    return res.json({ status: "success", message: "QR already scanned, session active" });
  }

  if (!session.qr) {
    return res.status(404).json({ error: "No QR available yet" });
  }

  try {
    const qrImage = await QRCode.toBuffer(session.qr);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": qrImage.length,
    });
    res.end(qrImage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send message API
app.post("/send-message", async (req, res) => {
  const { sessionId, phone, text, imageUrl, caption } = req.body;

  if (!sessionId || !phone) {
    return res.status(400).json({ error: "sessionId and phone are required" });
  }

  const session = sessions[sessionId];
  if (!session || !session.sock || !session.connected) {
    return res.status(400).json({ error: "Invalid sessionId or session not connected" });
  }

  try {
    const jid = `${phone}@s.whatsapp.net`;

    if (imageUrl) {
      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data, "binary");

      await session.sock.sendMessage(jid, {
        image: buffer,
        caption: caption || text || "",
      });
    } else if (text) {
      await session.sock.sendMessage(jid, { text });
    } else {
      return res.status(400).json({ error: "Either text or imageUrl is required" });
    }

    res.json({
      status: "success",
      message: "Message sent successfully",
      to: phone,
    });
  } catch (err) {
    console.error("❌ Send message error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  restoreSessions(); // Restore sessions on startup
});
