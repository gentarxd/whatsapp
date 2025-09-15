import express from "express";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";

const app = express();
app.use(express.json());

const sessions = {};

async function connectToWhatsApp(sessionId) {
  const authFolder = `./sessions/${sessionId}`;
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

  sessions[sessionId].sock = sock;
  return sock;
}

// ✅ Create / reconnect session
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

// ✅ Auto-connect if not connected when checking status
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
    const qrImage = await QRCode.toDataURL(session.qr);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
