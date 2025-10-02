import express from "express"
import makeWASocket, { useMultiFileAuthState, initAuthCreds, BufferJSON } from "@whiskeysockets/baileys"
import { createClient } from "@supabase/supabase-js"
import qrcode from "qrcode"
import axios from "axios"

const app = express()
app.use(express.json())

// Connect Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const sessions = {} // { id: { sock, webhookUrl } }

// -----------------
// Helpers
// -----------------
async function loadAuth(sessionId) {
  const { data, error } = await supabase
    .from("baileys")
    .select("data")
    .eq("id", sessionId)
    .single()

  if (error) {
    console.log("⚠️ loadAuth error:", error.message)
    return null
  }
  return data?.data || null
}

async function saveAuth(sessionId, state) {
  const { error } = await supabase
    .from("baileys")
    .upsert({ id: sessionId, data: state })

  if (error) console.log("⚠️ saveAuth error:", error.message)
}

// -----------------
// WhatsApp Logic
// -----------------
async function startSock(sessionId, webhookUrl) {
  const savedState = await loadAuth(sessionId)

  let creds, keys
  if (savedState) {
    creds = BufferJSON.reviver(null, savedState.creds)
    keys = savedState.keys
  } else {
    creds = initAuthCreds()
    keys = {}
  }

  const state = { creds, keys }
  const sock = makeWASocket({ auth: state, printQRInTerminal: false })

  // Save creds update
  sock.ev.on("creds.update", async (creds) => {
    await saveAuth(sessionId, { creds, keys: state.keys })
  })

  // Forward messages to webhook
  sock.ev.on("messages.upsert", async (m) => {
    if (!webhookUrl) return
    try {
      await axios.post(webhookUrl, {
        sessionId,
        messages: m.messages,
        type: m.type,
      })
    } catch (err) {
      console.log("⚠️ Webhook error:", err.message)
    }
  })

  sessions[sessionId] = { sock, webhookUrl }
  return sock
}

// -----------------
// API Routes
// -----------------

// 1- Create session + return QR as PNG
app.post("/create-session/:id", async (req, res) => {
  const sessionId = req.params.id
  const { webhookUrl } = req.body

  const sock = await startSock(sessionId, webhookUrl)

  sock.ev.on("connection.update", async (update) => {
    if (update.qr) {
      res.setHeader("Content-Type", "image/png")
      qrcode.toFileStream(res, update.qr)
    }
  })
})

// 2- Get QR again if needed
app.get("/qr/:id", async (req, res) => {
  const sessionId = req.params.id
  const { sock } = sessions[sessionId] || {}

  if (!sock) return res.status(400).json({ error: "Session not found" })

  sock.ev.on("connection.update", async (update) => {
    if (update.qr) {
      res.setHeader("Content-Type", "image/png")
      qrcode.toFileStream(res, update.qr)
    }
  })
})

// 3- Send message
app.post("/send/:id", async (req, res) => {
  const sessionId = req.params.id
  const { number, message } = req.body

  const session = sessions[sessionId]
  if (!session) return res.status(400).json({ error: "Session not found" })

  try {
    await session.sock.sendMessage(number + "@s.whatsapp.net", { text: message })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// -----------------
app.listen(3000, () => console.log("🚀 Server running on port 3000"))
