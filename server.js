import "dotenv/config";
import express from "express";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import axios from "axios";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";

// This version includes the /create-session endpoint and has no API key.
// WARNING: This server is open to the public.

const app = express();
app.use(express.json());

const sessions = {};
const qrCodes = {};
const sessionStatus = {};
const sessionConfig = {};

const PORT = process.env.PORT || 3000;
const PREFERRED_SESSION_ID = process.env.PREFERRED_SESSION || null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEFAULT_WEBHOOK_URL = process.env.DEFAULT_WEBHOOK_URL;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_KEY are required.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function loadSession(sessionId) {
  const { data, error } = await supabase.from("baileys").select("data").eq("id", sessionId).single();
  if (error && error.code !== 'PGRST116') {
    console.error("Error loading session:", error.message);
    return null;
  }
  return data?.data || null;
}

async function saveSession(sessionId, authState) {
  const { error } = await supabase.from("baileys").upsert({ id: sessionId, data: authState });
  if (error) console.error("Error saving session:", error.message);
}

async function startSock(sessionId) {
  try {
    if (!sessionId) throw new Error("sessionId is required");
    if (sessions[sessionId]) return sessions[sessionId];

    const savedAuth = await loadSession(sessionId);
    const sock = makeWASocket({ printQRInTerminal: false, auth: savedAuth || undefined });

    sock.ev.on("creds.update", async (creds) => {
      await saveSession(sessionId, { creds, keys: sock.authState.keys });
    });

    const pingInterval = setInterval(() => {
        if (sock?.ws?.readyState === 1) sock.sendPresenceUpdate("available");
    }, 60 * 1000);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrCodes[sessionId] = qr;
        sessionStatus[sessionId] = "qr";
      }
      if (connection === "open") {
        sessionStatus[sessionId] = "open";
        console.log(`Session ${sessionId} connected ✅`);
        delete qrCodes[sessionId];
      }
      if (connection === "close") {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log(`🔄 Connection closed for ${sessionId}, attempting reconnect...`);
          delete sessions[sessionId];
          setTimeout(() => startSock(sessionId), 5000);
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
      const webhookUrl = sessionConfig[sessionId]?.webhookUrl || DEFAULT_WEBHOOK_URL;
      if (!msg.message || !webhookUrl) return;

      try {
        await axios.post(webhookUrl, { sessionId, from: msg.key.remoteJid, text: msg.message.conversation || msg.message.extendedTextMessage?.text || null, raw: msg });
      } catch (err) {
        console.error(`❌ Error sending to webhook for ${sessionId}:`, err.message);
      }
    });

    sessions[sessionId] = sock;
    return sock;
  } catch (err) {
    console.error(`startSock error for ${sessionId}:`, err.message);
    delete sessions[sessionId];
    throw err;
  }
}

// =======================
// Routes
// =======================

app.post("/create-session", async (req, res) => {
  const body = req.body || {};
  const { sessionId, webhookUrl } = body;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  sessionConfig[sessionId] = { webhookUrl };

  if (sessions[sessionId]) {
    return res.status(200).json({ success: true, message: `Session '${sessionId}' already exists.` });
  }

  try {
    await startSock(sessionId);
    res.status(200).json({ success: true, message: `Session '${sessionId}' is starting.` });
  } catch (e) {
    res.status(500).json({ success: false, error: "Failed to start session: " + e.message });
  }
});



app.get("/get-qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  
  const status = sessionStatus[sessionId];
  const qr = qrCodes[sessionId];

  if (status === 'qr' && qr) {
    try {
      const qrImage = await QRCode.toDataURL(qr);
      res.send(`<img src="${qrImage}" alt="Scan this QR code with WhatsApp" />`);
    } catch (e) {
      res.status(500).json({ error: "Error generating QR code image." });
    }
  } else if (status === 'open') {
    res.send("Session is already connected. No QR code available.");
  } else {
    res.status(202).json({ message: "QR code not ready yet. Please wait a few seconds and try again." });
  }
});

app.get("/status/:sessionId", (req, res) => {
  res.json({ status: sessionStatus[req.params.sessionId] || "unknown" });
});

app.post("/send", async (req, res) => {
  const { sessionId, phone, text } = req.body;
  const sock = sessions[sessionId];
  
  if (sock && sessionStatus[sessionId] === 'open') {
    try {
      await sock.sendMessage(phone + "@s.whatsapp.net", { text });
      res.json({ success: true, message: "Message sent!" });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  } else {
    res.status(404).json({ success: false, error: `Session '${sessionId}' is not connected.` });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (PREFERRED_SESSION_ID) {
    console.log(`Attempting to start preferred session: ${PREFERRED_SESSION_ID}`);
    startSock(PREFERRED_SESSION_ID).catch(err => {
      console.error(`Failed to start preferred session ${PREFERRED_SESSION_ID}:`, err.message);
    });
  }
});
