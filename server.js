import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import axios from "axios";

const sessions = {}; // { sessionId: { sock, connected, qr } }

async function connectToWhatsApp(sessionId) {
  const DISK_PATH = process.env.SESSION_PATH || "./sessions";
  const authFolder = `${DISK_PATH}/${sessionId}`;

  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  // init session object once
  if (!sessions[sessionId]) {
    sessions[sessionId] = { sock: null, connected: false, qr: null };
  }
  sessions[sessionId].sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[sessionId].qr = qr;
      sessions[sessionId].connected = false;
      console.log(`🔑 QR generated for ${sessionId}`);
    }

    if (connection === "open") {
      sessions[sessionId].connected = true;
      sessions[sessionId].qr = null;
      console.log(`✅ Session ${sessionId} connected`);
    }

    if (connection === "close") {
      sessions[sessionId].connected = false;
      console.log(`❌ Session ${sessionId} closed`);

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`🔄 Reconnecting ${sessionId}...`);
        connectToWhatsApp(sessionId);
      }
    }
  });

  return sock;
}

const app = express();
app.use(express.json());

// create/connect session
app.post("/connect", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (!sessions[sessionId] || !sessions[sessionId].connected) {
    connectToWhatsApp(sessionId);
  }

  res.json({ message: `Session ${sessionId} initializing...` });
});

// check status
app.get("/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const s = sessions[sessionId];
  if (!s) return res.status(404).json({ error: "Session not found" });

  res.json({
    sessionId,
    connected: s.connected,
    qr: s.qr ? true : false,
  });
});

// debug full session object
app.get("/debug/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const s = sessions[sessionId];
  if (!s) return res.status(404).json({ error: "Session not found" });

  res.json(s);
});

// get QR png
app.get("/get-qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const s = sessions[sessionId];
  if (!s) return res.status(404).json({ error: "Session not found" });

  if (!s.qr && s.connected) {
    return res.json({ status: "success", message: "Already connected" });
  }

  if (!s.qr) {
    return res.status(404).json({ error: "No QR available yet" });
  }

  const qrImage = await QRCode.toDataURL(s.qr);
  const img = Buffer.from(qrImage.split(",")[1], "base64");
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": img.length,
  });
  res.end(img);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
