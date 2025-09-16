import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const sessions = {};
const SESSION_PATH = process.env.SESSION_PATH || "./sessions";

// 🔄 Connect or restore WhatsApp session
async function connectToWhatsApp(sessionId) {
  const authFolder = path.join(SESSION_PATH, sessionId);

  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const sock = makeWASocket({ auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`🔑 QR generated for ${sessionId}`);
      sessions[sessionId].qr = qr;
    }

    if (connection === "open") {
      console.log(`✅ Session ${sessionId} connected`);
      sessions[sessionId].connected = true;
      sessions[sessionId].qr = null;
      sessions[sessionId].sock = sock;
    } else if (connection === "close") {
      console.log(`❌ Session ${sessionId} closed`);
      sessions[sessionId].connected = false;

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`🔄 Reconnecting ${sessionId}...`);
        connectToWhatsApp(sessionId);
      }
    }
  });

  // ✅ Ensure session object exists
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

// 🔄 Restore sessions on server start
async function restoreSessions() {
  if (!fs.existsSync(SESSION_PATH)) return;

  const sessionDirs = fs.readdirSync(SESSION_PATH);
  for (const sessionId of sessionDirs) {
    console.log("🔄 Restoring session:", sessionId);

    if (!sessions[sessionId]) {
      sessions[sessionId] = { connected: false, qr: null };
    }

    await connectToWhatsApp(sessionId);
  }
}

// 📌 API Endpoints
app.post("/connect", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  await connectToWhatsApp(sessionId);
  res.json({ message: `Connecting ${sessionId}` });
});

app.get("/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  let session = sessions[sessionId];

  if (!session) {
    // 🟢 Try restoring from disk if missing in memory
    const authFolder = path.join(SESSION_PATH, sessionId);
    if (fs.existsSync(authFolder)) {
      console.log(`♻️ Restoring ${sessionId} on-demand...`);
      await connectToWhatsApp(sessionId);
      session = sessions[sessionId];
    }
  }

  if (!session) return res.status(404).json({ error: "Session not found" });

  res.json({
    sessionId,
    connected: session.connected || false,
    qr: session.qr ? true : false,
  });
});

app.post("/send-message", async (req, res) => {
  const { sessionId, phone, text, imageUrl, caption } = req.body;
  if (!sessionId || !phone)
    return res.status(400).json({ error: "sessionId and phone are required" });

  const session = sessions[sessionId];
  if (!session || !session.connected)
    return res.status(400).json({ error: "Session not connected" });

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
    res.status(500).json({ error: err.message });
  }
});

// 🚀 Start server
app.listen(3000, async () => {
  console.log("Server running on port 3000");
  await restoreSessions();
});
