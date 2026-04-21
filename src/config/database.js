// src/config/database.js
// ============================================================
//  Singleton de PrismaClient con logging según entorno.
// ============================================================

"use strict";

const { PrismaClient } = require("@prisma/client");
const { NODE_ENV }     = require("./env");

const prisma = new PrismaClient({
  log: NODE_ENV === "development"
    ? ["query", "info", "warn", "error"]
    : ["warn", "error"],
});

// Capturar errores de consulta para no exponer detalles en producción
prisma.$on("error", (e) => {
  console.error("❌ Prisma error:", e.message);
});

module.exports = prisma;
