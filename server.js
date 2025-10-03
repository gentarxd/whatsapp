import express from "express";
import makeWASocket, { proto, useSingleFileAuthState } from "@whiskeysockets/baileys"; // Modified import
import Pino from "pino";
import QRCode from "qrcode";
import axios from "axios";
import Redis from "ioredis"; // New import for Redis

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

// ========== Redis Client Setup ==========
// This will automatically use the REDIS_URL from your environment variables on Railway
const redis = new Redis(process.env.REDIS_URL);

// ========== In-memory storage (for temporary data) ==========
const sessions = {};      // sessionId -> socket
const qrCodes = {};       // sessionId -> qr
const sessionStatus = {}; // sessionId -> "qr" | "open" | "close"
const messageQueue = [];
const messageStatus = {}; // phone -> queued/sent/error

// ========== Middleware API Key ==========
function requireApiKey(req, res, next) {
    if (API_KEY) {
        const key = req.headers["x-api-key"];
        if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
    }
    next();
}

// ========== Wait for QR ==========
function waitForQR(sessionId, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if (qrCodes[sessionId]) return resolve(qrCodes[sessionId]);
            if (sessionStatus[sessionId] === "open") return resolve(null); // Already connected
            if (Date.now() - start > timeout) return reject(new Error("QR not generated in time"));
            setTimeout(check, 100);
        };
        check();
    });
}

// ========== Start WhatsApp Socket (The Correct Redis Version) ==========
async function startSock(sessionId) {
    if (!sessionId) throw new Error("sessionId required");
    if (sessions[sessionId]) return sessions[sessionId];

    const redisKey = `session-${sessionId}`;

    // This is the new logic to use Redis for storing session data
    const { state, saveCreds } = await useSingleFileAuthState(
        redisKey, // Using a simple key for single file auth state
        {
            // Custom functions to read and write the state from/to Redis
            read: async () => {
                try {
                    const data = await redis.get(redisKey);
                    return data ? JSON.parse(data, proto.Message.toJSON) : null;
                } catch (error) {
                    console.error("Failed to read session from Redis:", error);
                    return null;
                }
            },
            write: async (data) => {
                try {
                    const replacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;
                    await redis.set(redisKey, JSON.stringify(data, replacer));
                } catch (error) {
                    console.error("Failed to save session to Redis:", error);
                }
            }
        }
    );

    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
        logger: Pino({ level: "silent" }),
    });

    sessions[sessionId] = sock;

    // This will save the session to Redis whenever credentials are updated
    sock.ev.on("creds.update", saveCreds);

    // Event handlers for connection status
    sock.ev.on("connection.update", (update) => {
        const { connection, qr } = update;
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
            delete sessions[sessionId]; // Remove from active memory
        }
    });

    // Event handler for incoming messages
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg?.message) return;
        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
        console.log(`💬 New message from ${from}: ${text}`);
        try {
            await axios.post(process.env.WEBHOOK_URL, { sessionId, from, text, raw: msg });
        } catch (err) {
            console.error("❌ Error sending to webhook:", err?.message || err);
        }
    });

    return sock;
}

// ========== Routes ==========

// Create session
app.post("/create-session", requireApiKey, async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ error: "sessionId required" });
        await startSock(sessionId);
        res.json({ message: "session created", sessionId });
    } catch (err) {
        console.error("/create-session error:", err?.message || err);
        res.status(500).json({ error: "failed to create session" });
    }
});

// Get QR
app.get("/get-qr/:sessionId", requireApiKey, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const qr = await waitForQR(sessionId);

        if (!qr) {
            return res.json({ status: "success", message: "QR already scanned, session active" });
        }

        const qrImage = await QRCode.toDataURL(qr);
        const img = Buffer.from(qrImage.split(",")[1], "base64");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": img.length });
        res.end(img);
    } catch (err) {
        console.error("/get-qr error:", err?.message || err);
        res.status(404).json({ error: "QR not available" });
    }
});

// Send message
app.post("/send-message", requireApiKey, async (req, res) => {
    try {
        const { sessionId, phone, text, imageUrl } = req.body;
        if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });

        messageQueue.push({ sessionId, phone, text, imageUrl });
        messageStatus[phone] = "queued";
        res.json({ status: "queued", phone });
    } catch (err) {
        console.error("/send-message error:", err?.message || err);
        res.status(500).json({ error: "failed to queue message" });
    }
});

// Message status
app.get("/message-status", requireApiKey, (req, res) => res.json(messageStatus));

// Session status
app.get("/status/:sessionId", requireApiKey, (req, res) => {
    res.json({ sessionId: req.params.sessionId, status: sessionStatus[req.params.sessionId] || "not_found" });
});

app.get("/", (req, res) => res.send("Server is running!"));

// ========== Message Queue Processor ==========
setInterval(async () => {
    if (messageQueue.length === 0) return;

    const { sessionId, phone, text, imageUrl } = messageQueue.shift();
    const sock = sessions[sessionId];
    if (!sock) {
        messageStatus[phone] = "no_session";
        return;
    }

    const jid = `${phone}@s.whatsapp.net`;
    try {
        if (imageUrl) {
            const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
            const buffer = Buffer.from(response.data, "binary");
            await sock.sendMessage(jid, { image: buffer, caption: text || "" });
        } else {
            await sock.sendMessage(jid, { text: text || " " });
        }
        messageStatus[phone] = "sent";
    } catch (err) {
        console.error(`[queue] Error sending to ${phone}:`, err?.message || err);
        messageStatus[phone] = "error";
    }
}, 2000);

// Error handlers
process.on("uncaughtException", (err) => console.error("uncaughtException:", err?.message || err));
process.on("unhandledRejection", (reason, p) => console.error("unhandledRejection at:", p, "reason:", reason));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
