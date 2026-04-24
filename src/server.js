// src/server.js
// ============================================================
//  Punto de entrada principal — v2 (con job de recordatorios)
// ============================================================

"use strict";

const env = require("./config/env");

const http    = require("http");
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");

const { initSocket }          = require("./socket/socket");
const { redis }               = require("./config/redis");
const routes                  = require("./routes");
const { iniciarRecordatorios } = require("./jobs/reminders");

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
app.set("trust proxy", 1);

app.use(routes);

app.use((_req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.use((err, _req, res, _next) => {
  console.error("❌ Error no manejado:", err);
  res.status(500).json({ error: "Error interno del servidor." });
});

const httpServer = http.createServer(app);
initSocket(httpServer);

async function start() {
  await redis.ping();
  console.log("✅ Ping a Redis exitoso.");

  httpServer.listen(env.PORT, () => {
    console.log(`\n🚀 IPS Salud Vida API corriendo en puerto ${env.PORT}`);
    console.log(`   Entorno: ${env.NODE_ENV}`);
    console.log(`   WebSocket: habilitado`);
  });

  // ── Job de recordatorios ─────────────────────────────────
  if (env.NODE_ENV !== "test") {
    iniciarRecordatorios();
  }
}

start().catch(err => {
  console.error("❌ Error fatal al arrancar:", err);
  process.exit(1);
});

try {
  const { handleBot } = require("../bot");
  routes.setHandleBot(handleBot);
  console.log("✅ bot.js integrado con el webhook.");
} catch {
  console.warn("⚠️  bot.js no encontrado.");
}

module.exports = { app, httpServer };
