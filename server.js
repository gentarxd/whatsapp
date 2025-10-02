import "dotenv/config"; // CHANGE: Loads .env file
import express from "express";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import axios from "axios";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// Global state objects
const sessions = {};
const qrCodes = {};
const sessionStatus = {};

// Environment variables
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const PREFERRED_SESSION_ID = process.env.PREFERRED_SESSION || null;

// CHANGE 1: Remove ALL hardcoded secrets. They must come from your .env file.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// Check for required environment variables
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_KEY are required environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CHANGE 2: Add API Key authentication middleware
function authenticate(req, res, next) {
  const providedApiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!API_KEY || providedApiKey === API_KEY) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

// Supabase session functions
async function loadSession(sessionId) {
  const { data, error } = await supabase.from("baileys").select("data").eq("id", sessionId).single();
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    console.error("Error loading session:", error.message);
    return null;
  }
  return data?.data || null;
}

async function saveSession(sessionId, authState) {
  const { error } = await supabase.from("baileys").upsert({ id: sessionId, data: authState });
  if (error) console.error("Error saving session:", error.message);
}

// Main WhatsApp connection logic
async function startSock(sessionId) {
  try {
    if (!sessionId) throw new Error("sessionId is required");
    if (sessions[sessionId]) return sessions[sessionId];

    const savedAuth = await loadSession(sessionId);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: savedAuth || undefined,
    });

    sock.ev.on("creds.update", async (creds) => {
      await saveSession(sessionId, { creds, keys: sock.authState.keys });
    });

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
        console.log(`QR generated for ${sessionId}`);
      }

      if (connection === "open") {
        sessionStatus[sessionId] = "open";
        console.log(`Session ${sessionId} connected ✅`);
        delete qrCodes[sessionId];
      }

      if (connection === "close") {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log(`🔄 Connection closed, attempting reconnect in 5s...`);
          delete sessions[sessionId];
          setTimeout(() => startSock(sessionId).catch(e => console.error(`Reconnection error:`, e)), 5000);
        } else {
          sessionStatus[sessionId] = "logged_out";
          console.log(`Session ${sessionId} logged out.`);
          clearInterval(pingInterval);
          delete sessions[sessionId];
        }
      }
    });

    sock.ev.on("messages.upsert", async (m) => {
      const msg = m.messages[0];
      if (!msg.message || !N8N_WEBHOOK_URL) return;

      try {
        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || null;
        console.log(`💬 New message from ${from}: ${text}`);

        await axios.post(N8N_WEBHOOK_URL, { sessionId, from, text, raw: msg }, { timeout: 10000 });
      } catch (err) {
        console.error("❌ Error sending to n8n webhook:", err?.message);
      }
    });

    sessions[sessionId] = sock;
    return sock;

  } catch (err) {
    console.error(`startSock(${sessionId}) error:`, err?.message);
    delete sessions[sessionId]; // Clean up failed session attempt
    throw err;
  }
}


// =======================
// Routes
// =======================

app.get("/qr/:sessionId", authenticate, async (req, res) => {
  const { sessionId } = req.params;
  try {
    if (!sessions[sessionId]) {
      await startSock(sessionId);
    }
    // Wait a bit for the QR to generate
    setTimeout(async () => {
      if (qrCodes[sessionId]) {
        const qr = await QRCode.toDataURL(qrCodes[sessionId]);
        return res.send(`<img src="${qr}" alt="Scan this QR code with WhatsApp" />`);
      }
      res.send("No QR available. Check status or try again in a few seconds.");
    }, 3000); // 3-second delay
  } catch (e) {
    res.status(500).send("Error starting session: " + e.message);
  }
});

app.get("/status/:sessionId", authenticate, (req, res) => {
  const { sessionId } = req.params;
  res.json({ status: sessionStatus[sessionId] || "unknown" });
});

// CHANGE 3: Make the /send route more efficient
app.post("/send", authenticate, async (req, res) => {
  const { sessionId, phone, text } = req.body;
  
  const sock = sessions[sessionId];
  const status = sessionStatus[sessionId];

  if (sock && status === 'open') {
    try {
      const jid = phone + "@s.whatsapp.net";
      await sock.sendMessage(jid, { text });
      res.json({ success: true, message: "Message sent!" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  } else {
    res.status(404).json({ success: false, error: `Session '${sessionId}' not connected. Status: ${status || 'unknown'}` });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // CHANGE 4: Automatically start the preferred session
  if (PREFERRED_SESSION_ID) {
    console.log(`Attempting to start preferred session: ${PREFERRED_SESSION_ID}`);
    startSock(PREFERRED_SESSION_ID).catch(err => {
      console.error(`Failed to start preferred session ${PREFERRED_SESSION_ID}:`, err.message);
    });
  }
});
