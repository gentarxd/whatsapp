import express from "express";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";

const app = express();
app.use(express.json());

const sessions = {};

async function connectToWhatsApp(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
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
      console.log(`🔑 QR for ${sessionId}:`, qr);
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
        connectToWhatsApp(sessionId);
      }
    }
  });
}

app.post("/connect", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  if (!sessions[sessionId]) {
    sessions[sessionId] = { connected: false, qr: null };
    connectToWhatsApp(sessionId);
  }

  res.json({ message: `Session ${sessionId} is being initialized.` });
});

app.get("/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json({
    sessionId,
    connected: session.connected || false,
    qr: session.qr || null,
  });
});

// ✅ Get QR as real PNG image
// ✅ Get QR as real PNG image
app.get("/get-qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (!session || !session.qr) {
    return res.status(404).send("QR not found");
  }

  try {
    // نحول النص (اللي شكله زي 2@BWEWk4...) لصورة QR
    const qrBuffer = await QRCode.toBuffer(session.qr, {
      type: "png",
      width: 300,
      errorCorrectionLevel: "H",
    });

    res.type("png");       // نقول للمتصفح إن ده PNG
    res.send(qrBuffer);    // نبعت الصورة كـ raw bytes
  } catch (err) {
    console.error("QR error:", err);
    res.status(500).send("Failed to generate QR");
  }
});

app.post("/send-message", async (req, res) => {
  const { sessionId, number, message } = req.body;

  if (!sessionId || !number || !message) {
    return res.status(400).json({ error: "sessionId, number, and message are required" });
  }

  const session = sessions[sessionId];
  if (!session || !session.connected || !session.sock) {
    return res.status(400).json({ error: "Session is not connected." });
  }

  try {
    const jid = `${number}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));