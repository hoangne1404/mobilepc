const http = require("http");
const crypto = require("crypto");
const path = require("path");

const express = require("express");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60;

function generateSessionId() {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6);
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 1000 * 60).unref();

app.use(express.static(path.join(__dirname, "public")));

app.get("/qr", async (req, res) => {
  const text = req.query.text;
  if (!text || typeof text !== "string") {
    res.status(400).send("Missing text");
    return;
  }

  try {
    const png = await QRCode.toBuffer(text, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.end(png);
  } catch (e) {
    res.status(500).send("QR generation failed");
  }
});

io.on("connection", (socket) => {
  socket.on("pc:create-session", (ack) => {
    let sessionId = generateSessionId();
    while (sessions.has(sessionId)) sessionId = generateSessionId();

    sessions.set(sessionId, {
      createdAt: Date.now(),
      pcSocketId: socket.id,
      mobileSocketId: null
    });

    socket.join(sessionId);
    if (typeof ack === "function") ack({ ok: true, sessionId });
  });

  socket.on("pc:end-session", ({ sessionId } = {}) => {
    if (!sessionId) return;
    const s = getSession(sessionId);
    if (!s || s.pcSocketId !== socket.id) return;

    io.to(sessionId).emit("session:ended");
    sessions.delete(sessionId);
  });

  socket.on("mobile:join", ({ sessionId } = {}, ack) => {
    if (!sessionId) {
      if (typeof ack === "function") ack({ ok: false, reason: "missing_session" });
      return;
    }

    const s = getSession(sessionId);
    if (!s || !s.pcSocketId) {
      if (typeof ack === "function") ack({ ok: false, reason: "session_not_found" });
      return;
    }

    s.mobileSocketId = socket.id;
    sessions.set(sessionId, s);
    socket.join(sessionId);

    io.to(s.pcSocketId).emit("session:mobile-connected");
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("webrtc:offer", ({ sessionId, sdp } = {}) => {
    const s = sessionId ? getSession(sessionId) : null;
    if (!s || s.mobileSocketId !== socket.id) return;
    io.to(s.pcSocketId).emit("webrtc:offer", { sdp });
  });

  socket.on("webrtc:answer", ({ sessionId, sdp } = {}) => {
    const s = sessionId ? getSession(sessionId) : null;
    if (!s || s.pcSocketId !== socket.id || !s.mobileSocketId) return;
    io.to(s.mobileSocketId).emit("webrtc:answer", { sdp });
  });

  socket.on("webrtc:ice-candidate", ({ sessionId, candidate } = {}) => {
    const s = sessionId ? getSession(sessionId) : null;
    if (!s) return;

    if (socket.id === s.mobileSocketId && s.pcSocketId) {
      io.to(s.pcSocketId).emit("webrtc:ice-candidate", { candidate });
      return;
    }

    if (socket.id === s.pcSocketId && s.mobileSocketId) {
      io.to(s.mobileSocketId).emit("webrtc:ice-candidate", { candidate });
    }
  });

  socket.on("mobile:stop", ({ sessionId } = {}) => {
    const s = sessionId ? getSession(sessionId) : null;
    if (!s || s.mobileSocketId !== socket.id) return;
    io.to(s.pcSocketId).emit("mobile:stopped");
  });

  socket.on("disconnect", () => {
    for (const [sessionId, s] of sessions.entries()) {
      if (s.pcSocketId === socket.id) {
        io.to(sessionId).emit("session:ended");
        sessions.delete(sessionId);
        continue;
      }
      if (s.mobileSocketId === socket.id) {
        s.mobileSocketId = null;
        sessions.set(sessionId, s);
        io.to(s.pcSocketId).emit("session:mobile-disconnected");
      }
    }
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});

