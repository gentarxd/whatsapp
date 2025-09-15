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

// API: Get QR as PNG
// Endpoint: صفحة HTML تعرض QR وتحدث تلقائياً
app.get("/qr-page/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (!session) return res.status(404).send("Session not found");

  // صفحة HTML بسيطة
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WhatsApp QR</title>
        <style>
          body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; }
          img { margin-top: 20px; border: 2px solid #000; }
        </style>
      </head>
      <body>
        <h1>Scan this QR to connect WhatsApp</h1>
        <img id="qr" src="/get-qr/${sessionId}" alt="WhatsApp QR" />
        <script>
          // تحديث الصورة كل 5 ثواني
          setInterval(() => {
            const img = document.getElementById('qr');
            img.src = '/get-qr/${sessionId}?t=' + new Date().getTime();
          }, 5000);
        </script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));