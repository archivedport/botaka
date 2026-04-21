// src/server.js
// ============================================================
//  Punto de entrada principal.
//  Inicializa Express, Socket.io, rutas y conexiones.
// ============================================================

"use strict";

// Cargar y validar variables de entorno PRIMERO
const env = require("./config/env");

const http    = require("http");
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");

const { initSocket }  = require("./socket/socket");
const { redis }       = require("./config/redis");
const routes          = require("./routes");

// ── App Express ───────────────────────────────────────────────
const app = express();

// Seguridad: headers HTTP
app.use(helmet({
  contentSecurityPolicy: false, // Desactivar si tienes frontend en mismo origen
}));

// CORS
app.use(cors({
  origin: true,
  credentials: true,
}));

// Parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Logs de peticiones
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

// IP real detrás de Railway / proxy
app.set("trust proxy", 1);

// ── Rutas ─────────────────────────────────────────────────────
app.use(routes);

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

// ── Error handler global ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("❌ Error no manejado:", err);
  res.status(500).json({ error: "Error interno del servidor." });
});

// ── Servidor HTTP + Socket.io ─────────────────────────────────
const httpServer = http.createServer(app);
initSocket(httpServer);

// ── Arranque ──────────────────────────────────────────────────
async function start() {
  // Verificar conexión a Redis antes de arrancar
  await redis.ping();
  console.log("✅ Ping a Redis exitoso.");

  httpServer.listen(env.PORT, () => {
    console.log(`\n🚀 IPS Salud Vida API corriendo en puerto ${env.PORT}`);
    console.log(`   Entorno: ${env.NODE_ENV}`);
    console.log(`   WebSocket: habilitado`);
  });
}

start().catch(err => {
  console.error("❌ Error fatal al arrancar:", err);
  process.exit(1);
});

// ── Integración con bot.js ────────────────────────────────────
//  Si bot.js está en el mismo proceso, conectar su handleBot al webhook.
//  En Railway, ambos pueden correr en el mismo dyno.
try {
  const { handleBot } = require("../bot");
  routes.setHandleBot(handleBot);
  console.log("✅ bot.js integrado con el webhook.");
} catch {
  console.warn("⚠️  bot.js no encontrado. El webhook procesará solo mensajes en modo MANUAL.");
}

module.exports = { app, httpServer };
