// src/config/redis.js
// ============================================================
//  Cliente Redis (ioredis) con helpers para gestión de estado
//  de chat y caché de slots de calendario.
// ============================================================

"use strict";

const Redis        = require("ioredis");
const { REDIS_URL } = require("./env");

// ── Cliente principal ────────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck:     true,
  lazyConnect:          false,
});

redis.on("connect",   ()  => console.log("✅ Redis conectado"));
redis.on("ready",     ()  => console.log("✅ Redis listo"));
redis.on("error",     (e) => console.error("❌ Redis error:", e.message));
redis.on("close",     ()  => console.warn("⚠️  Redis conexión cerrada"));

// ── Prefijos de llaves ───────────────────────────────────────
const KEY = {
  chatStatus:    (phone)  => `ips:chat:status:${phone}`,      // BOT | MANUAL
  chatAsesor:    (phone)  => `ips:chat:asesor:${phone}`,      // asesorId activo
  chatAsesorReq: (phone)  => `ips:chat:asesor_req:${phone}`,  // solicitud pendiente
  slotCache:     (sedeSlug, fecha) => `ips:slots:${sedeSlug}:${fecha}`,
  slotSel:       (phone)  => `ips:slots:sel:${phone}`,        // slots en selección
  session:       (phone)  => `ips:session:${phone}`,
  asesorQueue:   ()       => "ips:asesor:cola",
  asesorBusy:    (id)     => `ips:asesor:busy:${id}`,
  asesorAssigned:(id)     => `ips:asesor:assigned:${id}`,     // phone usuario
  userAsesor:    (phone)  => `ips:user:asesor:${phone}`,      // asesorId
};

const TTL = {
  session:   60 * 60 * 24,     // 24 h
  slotCache: 60 * 5,           // 5 min (mayor frescura que antes)
  slotSel:   60 * 15,          // 15 min
  chatStatus: 0,               // sin expiración (persiste hasta cambio)
};

// ── Helpers de estado de chat ────────────────────────────────

/**
 * Obtiene el estado actual del chat para un número.
 * @returns {"BOT"|"MANUAL"}
 */
async function getChatStatus(phone) {
  const val = await redis.get(KEY.chatStatus(phone));
  return val === "MANUAL" ? "MANUAL" : "BOT";
}

/**
 * Cambia el estado del chat. Si pasa a MANUAL, registra el asesor.
 * @param {"BOT"|"MANUAL"} status
 */
async function setChatStatus(phone, status, asesorId = null) {
  const pipeline = redis.pipeline();
  pipeline.set(KEY.chatStatus(phone), status);
  if (status === "MANUAL" && asesorId) {
    pipeline.set(KEY.chatAsesor(phone), asesorId);
  } else if (status === "BOT") {
    pipeline.del(KEY.chatAsesor(phone));
  }
  await pipeline.exec();
}

/**
 * Devuelve el asesorId que tiene control manual del chat, o null.
 */
async function getChatAsesor(phone) {
  return redis.get(KEY.chatAsesor(phone));
}

// ── Helpers de caché de slots ────────────────────────────────

async function getSlotCache(sedeSlug, fecha) {
  const raw = await redis.get(KEY.slotCache(sedeSlug, fecha));
  return raw ? JSON.parse(raw) : null;
}

async function setSlotCache(sedeSlug, fecha, slots) {
  await redis.set(
    KEY.slotCache(sedeSlug, fecha),
    JSON.stringify(slots),
    "EX",
    TTL.slotCache
  );
}

async function invalidarSlotCache(sedeSlug, fecha) {
  // Si no se pasa fecha, borra todos los slots de esa sede
  if (fecha) {
    await redis.del(KEY.slotCache(sedeSlug, fecha));
  } else {
    const pattern = KEY.slotCache(sedeSlug, "*");
    const keys    = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }
}

// ── Helpers de sesión de bot ──────────────────────────────────

async function getSession(phone) {
  const raw = await redis.get(KEY.session(phone));
  return raw ? JSON.parse(raw) : { paso: "inicio", datos: {} };
}

async function saveSession(phone, session) {
  await redis.set(KEY.session(phone), JSON.stringify(session), "EX", TTL.session);
}

async function clearSession(phone) {
  await redis.del(KEY.session(phone));
}

// ── Helpers de selección de slots ─────────────────────────────

async function saveSlotSelection(phone, slots) {
  await redis.set(KEY.slotSel(phone), JSON.stringify(slots), "EX", TTL.slotSel);
}

async function getSlotSelection(phone) {
  const raw = await redis.get(KEY.slotSel(phone));
  return raw ? JSON.parse(raw) : null;
}

async function clearSlotSelection(phone) {
  await redis.del(KEY.slotSel(phone));
}

// ── Helpers de solicitud de asesor ────────────────────────────

async function setAsesorRequest(phone, motivo) {
  await redis.set(KEY.chatAsesorReq(phone), motivo || "sin motivo");
}

async function getAsesorRequest(phone) {
  return redis.get(KEY.chatAsesorReq(phone));
}

async function clearAsesorRequest(phone) {
  await redis.del(KEY.chatAsesorReq(phone));
}

/**
 * Devuelve todos los phones que tienen solicitud de asesor pendiente.
 */
async function getPendingAsesorRequests() {
  const keys = await redis.keys("ips:chat:asesor_req:*");
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  return keys.map((k, i) => ({
    phone:  k.replace("ips:chat:asesor_req:", ""),
    motivo: values[i],
  }));
}

module.exports = {
  redis,
  KEY,
  TTL,
  getChatStatus,
  setChatStatus,
  getChatAsesor,
  getSlotCache,
  setSlotCache,
  invalidarSlotCache,
  getSession,
  saveSession,
  clearSession,
  saveSlotSelection,
  getSlotSelection,
  clearSlotSelection,
  setAsesorRequest,
  getAsesorRequest,
  clearAsesorRequest,
  getPendingAsesorRequests,
};
