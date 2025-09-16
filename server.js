import express from "express";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import path from "path";

const app = express();
app.use(express.json());

const sessions = {};
const SESSION_PATH = process.env.SESSION_PATH || "./sessions";

// 📌 Connect to WhatsApp
async function connectToWhatsApp(sessionId) {
  const sessionFolder = path.join(SESSION_PATH, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`🔑 QR generated for ${sessionId}`);
      if (!sessions[sessionId]) sessions[sessionId] = {};
      sessions[sessionId].qr = qr;
      sessions[sessionId].connected = false;
    }

    if (connection === "open") {
      console.log(`✅ Session ${sessionId} connected`);
      sessions[sessionId] = {
        ...sessions[sessionId],
        sock,
        connected: true,
        qr: null,
      };
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

  sock.ev.on("creds.update", saveCreds);

  if (!sessions[sessionId]) {
    sessions[sessionId] = {};
  }
  sessions[sessionId] = {
    ...sessions[sessionId],
    sock,
    connected: false,
    qr: null,
  };

  return sock;
}

// 📌 Create Session
app.post("/connect", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  await connectToWhatsApp(sessionId);
  res.json({ success: true, message: `Session ${sessionId} is connecting` });
});

// 📌 Get Session Status
app.get("/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json({
    sessionId,
    connected: session.connected || false,
    qr: session.qr || false,
  });
});

// 📌 Send Message
app.post("/send-message", async (req, res) => {
  const { sessionId, phone, text, imageUrl, caption } = req.body;

  if (!sessionId || !phone) {
    return res.status(400).json({ error: "sessionId and phone are required" });
  }

  const session = sessions[sessionId];

  if (!session || !session.sock) {
    return res.status(400).json({ error: "Session not connected" });
  }

  try {
    if (imageUrl) {
      await session.sock.sendMessage(`${phone}@s.whatsapp.net`, {
        image: { url: imageUrl },
        caption: caption || "",
      });
    } else {
      await session.sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Send message error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
