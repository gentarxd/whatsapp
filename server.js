import express from "express";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";

const app = express();
app.use(express.json());

const sessions = {}; // نخزن السيشنز هنا

// Function: Connect Session
async function connectToWhatsApp(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  // حفظ البيانات
  sock.ev.on("creds.update", saveCreds);

  // متابعة الاتصال
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`🔑 QR for ${sessionId}:`, qr);
      sessions[sessionId].qr = qr; // نخزن الـ QR
    }

    if (connection === "open") {
      console.log(`✅ Session ${sessionId} connected`);
      sessions[sessionId].sock = sock;
      sessions[sessionId].connected = true;
      sessions[sessionId].qr = null; // مسح الـ QR بعد الاتصال
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

// API: Create Session
app.post("/connect", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  if (!sessions[sessionId]) {
    sessions[sessionId] = { connected: false, qr: null };
    connectToWhatsApp(sessionId);
  }

  res.json({ message: `Session ${sessionId} is being initialized.` });
});

// API: Get Session Status
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

// API: Get QR as Image
// API: Get QR as PNG
app.get("/get-qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (!session || !session.qr) return res.status(404).send("QR not found");

  try {
    // نحول الـ QR ل Buffer بدل data URL
    const qrBuffer = await QRCode.toBuffer(session.qr, { type: 'png' });
    
    res.setHeader('Content-Type', 'image/png');
    res.send(qrBuffer);
  } catch (err) {
    res.status(500).send("Failed to generate QR");
  }
});

// API: Send Message
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
