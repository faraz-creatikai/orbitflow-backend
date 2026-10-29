// socket/socket.js
import { ALLOWED_ORIGINS } from "../config/cors-origins.js";
import { registerPresence, startPresenceHeartbeat, closeStaleSessions } from "./presence.js";
// 👇 Import the WhatsApp controllers
import { initWhatsApp, stopWhatsAppIdle, getWhatsAppConnectionState } from "../config/baileys.js";
import { protectCustomerRoute } from "../middlewares/auth.js";
import { parse } from "cookie";

let io;

export const initSocket = async (server) => {
  const { Server } = await import("socket.io");
  io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket"],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // 2. add these two lines right after io is created
  await closeStaleSessions();   // clean sessions left open by a restart
  startPresenceHeartbeat();

  io.use((socket, next) => {
    if (socket.handshake.auth?.role !== "customer") return next(); // admins unchanged

    const req = socket.request;
    req.cookies = parse(req.headers.cookie || ""); // your middleware reads req.cookies.customerToken
    if (socket.handshake.auth.token) req.headers.customertoken = socket.handshake.auth.token; // only used if the frontend sends it

    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      next(err);
    };

    // Your middleware answers with res.status().json(). Over a socket that becomes a rejected connection.
    const res = { status: () => res, json: () => finish(new Error("unauthorized")) };

    protectCustomerRoute(req, res, () => {
      socket.data.customerId = req.customer.id;
      finish();
    });
  });

  io.on("connection", (socket) => {
    if (socket.data.customerId) {
      socket.join(`customer:${socket.data.customerId}`);
      return; // customers never reach presence or the WhatsApp handlers
    }
    const adminId = socket.handshake.auth?.adminId;
    console.log("🔌 admin socket connected", { adminId });
    if (adminId) {
      socket.join(`admin:${adminId}`);
    }

    registerPresence(io, socket);

    // ─── WHATSAPP VIEWER TRACKING (per admin) ───
    const waRoom = `whatsapp_qr_viewers:${adminId}`;

    socket.on("whatsapp:start_viewing", (ack) => {
      console.log("🔎 whatsapp:start_viewing", { adminId });
      if (!adminId) return;
      socket.join(waRoom);

      // initWhatsApp() is safe to call repeatedly (it returns early if an engine
      // already exists or is starting).
      const state = getWhatsAppConnectionState(adminId);
      console.log("🚦 WhatsApp state at start_viewing:", { adminId, status: state.status });
      if (state.status === 'loading') {
        initWhatsApp(adminId).catch((err) =>
          console.error(`❌ [${adminId}] initWhatsApp failed:`, err.message)
        );
      }

      // NEW: reply with the current status if the client asked for it
      if (typeof ack === "function") ack({ status: state.status });
    });

    socket.on("whatsapp:stop_viewing", () => {
      socket.leave(waRoom);
      checkViewersAndStop();
    });

    socket.on("disconnect", () => {
      checkViewersAndStop();
    });

    function checkViewersAndStop() {
      if (!adminId) return;
      const viewerCount = io.sockets.adapter.rooms.get(waRoom)?.size || 0;
      if (viewerCount === 0) stopWhatsAppIdle(adminId);
    }
  });

  return io;
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

export const getSocket = () => io ?? null;