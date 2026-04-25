// src/socket/socket.js
// ============================================================
//  Configuración de Socket.io para comunicación en tiempo real.
//
//  Salas (rooms):
//    chat:<phone>        — todos los mensajes de un número
//    asesores            — notificaciones globales a asesores
//    asesor:<asesorId>   — mensajes privados al asesor
//
//  Eventos emitidos al cliente web:
//    chat:new_message    — mensaje entrante de paciente
//    chat:message_sent   — confirmación de mensaje enviado
//    chat:status_changed — cambio de estado BOT/MANUAL
//    chat:typing         — indicador de escritura
//
//  Eventos recibidos del cliente web:
//    join:chat           — asesor se une a sala de un chat
//    leave:chat          — asesor sale de sala
// ============================================================

"use strict";

const { Server }    = require("socket.io");
const jwt           = require("jsonwebtoken");
const { jwt: jwtCfg } = require("../config/env");
const prisma        = require("../config/database");

let io = null;

/**
 * Inicializa Socket.io sobre el servidor HTTP.
 * @param {import("http").Server} httpServer
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin:      process.env.FRONTEND_URL || "*",
      methods:     ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // ── Middleware de autenticación para sockets ──────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
                 || socket.handshake.headers?.authorization?.replace("Bearer ", "");

      if (!token) return next(new Error("Token no proporcionado."));

      const payload = jwt.verify(token, jwtCfg.secret);
      const usuario = await prisma.usuario.findUnique({
        where:  { id: payload.sub },
        select: { id: true, nombre: true, rol: true, activo: true },
      });

      if (!usuario || !usuario.activo) return next(new Error("Usuario inactivo."));

      socket.usuario = usuario;
      next();
    } catch {
      next(new Error("Token inválido."));
    }
  });

  // ── Gestión de conexiones ─────────────────────────────────
  io.on("connection", (socket) => {
    const u = socket.usuario;
    console.log(`🔌 Socket conectado: ${u.nombre} (${u.id})`);

    // Unir automáticamente a sala personal del asesor
    socket.join(`asesor:${u.id}`);
    // Unir a sala global de asesores
    socket.join("asesores");

    // ── Unirse a chat de un paciente ──────────────────────
    socket.on("join:chat", ({ phone }) => {
      if (!phone) return;
      socket.join(`chat:${phone}`);
      console.log(`📱 ${u.nombre} se unió al chat:${phone}`);
    });

    // ── Salir de chat de un paciente ──────────────────────
    socket.on("leave:chat", ({ phone }) => {
      if (!phone) return;
      socket.leave(`chat:${phone}`);
    });

    socket.on("disconnect", () => {
      console.log(`🔌 Socket desconectado: ${u.nombre}`);
    });
  });

  console.log("✅ Socket.io inicializado.");
  return io;
}

/**
 * Devuelve la instancia de io (para usarla en controllers).
 */
function getIO() {
  if (!io) throw new Error("Socket.io no está inicializado. Llama initSocket primero.");
  return io;
}

/**
 * Emite un mensaje entrante de paciente a la sala del asesor.
 * Llamada desde el webhook de Meta cuando status === "MANUAL".
 *
 * @param {string} phone
 * @param {string} texto
 * @param {string} asesorId
 */
function emitirMensajePaciente(phone, texto, timestamp) {
  if (!io) return;
  const payload = {
    phone,
    from:      "PACIENTE",
    mensaje:   texto,
    timestamp: timestamp || new Date().toISOString(),
  };
  // Emitir a la sala específica del chat (para quien está dentro)
  io.to(`chat:${phone}`).emit("chat:new_message", payload);
  // Emitir también a TODOS los asesores (para actualizar la lista en tiempo real)
  io.to("asesores").emit("chat:new_message", payload);
}

/**
 * Notifica a todos los asesores conectados de un nuevo mensaje en cola.
 */
function notificarAsesores(event, data) {
  if (!io) return;
  io.to("asesores").emit(event, data);
}

/**
 * Envía una notificación directa a un asesor específico.
 */
function notificarAsesor(asesorId, event, data) {
  if (!io) return;
  io.to(`asesor:${asesorId}`).emit(event, data);
}

module.exports = { initSocket, getIO, emitirMensajePaciente, notificarAsesores, notificarAsesor };
