import express from "express";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import axios from "axios";
import fs from "fs";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const sessions = {};
const qrCodes = {};
const sessionStatus = {};
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

let preferredSessionId = process.env.PREFERRED_SESSION || null; // ex: "P1WM"
const AUTH_DIR = '/data/auth_info';

const messageQueue = [];
const messageStatus = {}; // { phone: "queued" | "sent" | "error" | "no_session" }

// =======================
// Supabase Config
// =======================
const SUPABASE_URL = process.env.SUPABASE_URL || "https://fbflyrvmbguezvdzgqaj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiZmx5cnZtYmd1ZXp2ZHpncWFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkzODUyMDksImV4cCI6MjA3NDk2MTIwOX0.U9E2KQG3-CNyJaA5tacYdDfipyAFHtVLFoDm-zDc10w";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 🗄️ تحميل الجلسة من Supabase
async function loadSession(sessionId) {
  const { data, error } = await supabase
    .from("baileys")
    .select("data")
    .eq("id", sessionId)
    .single();

  if (error) {
    console.error("Error loading session:", error.message);
    return null;
  }
  return data?.data || null;
}

// 🗄️ حفظ الجلسة في Supabase
async function saveSession(sessionId, authState) {
  const { error } = await supabase
    .from("baileys")
    .upsert({ id: sessionId, data: authState });

  if (error) console.error("Error saving session:", error.message);
}

// =======================
// Start WhatsApp Socket
// =======================
async function startSock(sessionId) {
  try {
    if (!sessionId) throw new Error("sessionId required for startSock");

    if (sessions[sessionId]) {
      console.log(`Session ${sessionId} already exists, returning existing socket.`);
      return sessions[sessionId];
    }

    // حمل الجلسة من Supabase
    const savedAuth = await loadSession(sessionId);

    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: savedAuth || undefined,
    });

    // ✅ حفظ الكريدينشالز في Supabase
    sock.ev.on("creds.update", async (creds) => {
      await saveSession(sessionId, { creds, keys: sock.authState.keys });
    });

    // ✅ Keep-Alive Ping
    const pingInterval = setInterval(() => {
      if (sock?.ws?.readyState === 1) {
        sock.sendPresenceUpdate("available");
        console.log(`📡 KeepAlive ping sent for ${sessionId}`);
      }
    }, 60 * 1000);

    sock.ev.on("connection.update", (update) => {
      try {
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
          sessionStatus[sessionId] = "close";
          console.log(`Session ${sessionId} closed ❌`);

          const shouldReconnect =
            (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect) {
            const target = preferredSessionId || sessionId;
            console.log(`🔄 Will attempt reconnect to "${target}" in 5s...`);

            try { delete sessions[sessionId]; } catch (e) { /* ignore */ }

            setTimeout(() => {
              startSock(target).catch(e =>
                console.error(`Reconnection error for ${target}:`, e?.message || e)
              );
            }, 5000);
          } else {
            sessionStatus[sessionId] = "logged_out";
            console.log(`Session ${sessionId} logged out. تحتاج QR جديد`);
            clearInterval(pingInterval);
          }
        }
      } catch (e) {
        console.error(`Error in connection.update handler for ${sessionId}:`, e?.message || e);
      }
    });

    // ✅ LISTENER للرسائل الجديدة
    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          null;

        console.log(`💬 New message from ${from}: ${text}`);

        // ابعت للـ webhook بتاع n8n
        await axios.post(
          "https://n8n-latest-znpr.onrender.com/webhook/909d7c73-112a-455b-988c-9f770852c8fa",
          {
            sessionId,
            from,
            text,
            raw: msg
          },
          { timeout: 10000 }
        );
      } catch (err) {
        console.error("❌ Error sending to n8n webhook:", err?.message || err);
      }
    });

    sessions[sessionId] = sock;
    return sock;
  } catch (err) {
    console.error(`startSock(${sessionId}) error:`, err?.message || err);
    throw err;
  }
}

// =======================
// Routes
// =======================

// ✅ Generate QR
app.get("/qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    if (!sessions[sessionId]) {
      await startSock(sessionId);
    }
    if (qrCodes[sessionId]) {
      const qr = await QRCode.toDataURL(qrCodes[sessionId]);
      return res.send(`<img src="${qr}" />`);
    }
    return res.send("No QR available, maybe already connected?");
  } catch (e) {
    return res.status(500).send("Error: " + e.message);
  }
});

// ✅ Session status
app.get("/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  return res.json({ status: sessionStatus[sessionId] || "unknown" });
});

// ✅ Send Message
app.post("/send", async (req, res) => {
  const { sessionId, phone, text } = req.body;
  try {
    const sock = await startSock(sessionId);
    await sock.sendMessage(phone + "@s.whatsapp.net", { text });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =======================
// Start Server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
