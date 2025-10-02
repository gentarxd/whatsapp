import express from "express";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import axios from "axios";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const sessions = {};
const qrCodes = {};
const sessionStatus = {};

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;
let preferredSessionId = process.env.PREFERRED_SESSION || null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL and SUPABASE_KEY are required.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===============
// Supabase utils
// ===============
async function loadSession(sessionId) {
  const { data, error } = await supabase
    .from("baileys")
    .select("data")
    .eq("id", sessionId)
    .single();
  if (error && error.code !== "PGRST116") {
    console.error("Error loading session:", error.message);
    return null;
  }
  return data?.data || null;
}

async function saveSession(sessionId, authState) {
  const { error } = await supabase
    .from("baileys")
    .upsert({ id: sessionId, data: authState });
  if (error) console.error("Error saving session:", error.message);
}

// ===============
// Start Socket
// ===============
async function startSock(sessionId) {
  try {
    if (!sessionId) throw new Error("sessionId required");
    if (sessions[sessionId]) return sessions[sessionId];

    // load auth state from Supabase
    const savedAuth = await loadSession(sessionId);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: savedAuth || undefined,
    });

    // Save auth whenever updated
    sock.ev.on("creds.update", async (creds) => {
      await saveSession(sessionId, { creds, keys: sock.authState.keys });
    });

    // Keep alive
    const pingInterval = setInterval(() => {
      if (sock?.ws?.readyState === 1) {
        sock.sendPresenceUpdate("available");
      }
    }, 60 * 1000);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrCodes[sessionId] = qr;
        sessionStatus[sessionId] = "qr";
        console.log(`📲 QR generated for ${sessionId}`);
      }
      if (connection === "open") {
        sessionStatus[sessionId] = "open";
        console.log(`✅ Session ${sessionId} connected`);
        delete qrCodes[sessionId];
      }
      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error)?.output?.statusCode !==
          DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log(`🔄 Reconnecting ${sessionId}...`);
          delete sessions[sessionId];
          setTimeout(() => startSock(sessionId), 5000);
        } else {
          sessionStatus[sessionId] = "logged_out";
          console.log(`❌ Session ${sessionId} logged out`);
          clearInterval(pingInterval);
          delete sessions[sessionId];
        }
      }
    });

    // Listen messages
    sock.ev.on("messages.upsert", async (m) => {
      const msg = m.messages[0];
      if (!msg.message) return;

      const from = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        null;

      console.log(`💬 Message from ${from}: ${text}`);

      // مثال: خزّن الرسائل كمان في supabase
      await supabase.from("messages").insert([
        {
          session_id: sessionId,
          from,
          text,
          raw: msg,
        },
      ]);
    });

    sessions[sessionId] = sock;
    return sock;
  } catch (err) {
    console.error(`startSock error for ${sessionId}:`, err.message);
    delete sessions[sessionId];
    throw err;
  }
}

// ===============
// Middleware
// ===============
function requireApiKey(req, res, next) {
  if (API_KEY) {
    const header = req.headers["x-api-key"];
    if (header !== API_KEY)
      return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ===============
// Routes
// ===============
app.post("/create-session", requireApiKey, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId)
    return res.status(400).json({ error: "sessionId required" });
  try {
    await startSock(sessionId);
    res.json({ message: "session created", sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/get-qr/:sessionId", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes[sessionId];
  if (qr) {
    const qrImage = await QRCode.toDataURL(qr);
    res.send(`<img src="${qrImage}" />`);
  } else if (sessionStatus[sessionId] === "open") {
    res.send("✅ Session already connected");
  } else {
    res.status(202).json({ message: "QR not ready yet" });
  }
});

app.get("/status/:sessionId", requireApiKey, (req, res) => {
  res.json({ sessionId, status: sessionStatus[req.params.sessionId] || "unknown" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (preferredSessionId) {
    startSock(preferredSessionId).catch((e) =>
      console.error("Preferred session error:", e.message)
    );
  }
});
