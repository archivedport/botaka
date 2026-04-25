// src/routes.js
// ============================================================
//  Registro central de todas las rutas de la API.
// ============================================================

"use strict";

const { Router } = require("express");

const { requireAuth, requireRol, trackAcceso } = require("./middleware/auth");

const authCtrl     = require("./modules/auth/auth.controller");
const chatCtrl     = require("./modules/chat/chat.controller");
const webhookCtrl  = require("./modules/chat/webhook.controller");
const calCtrl      = require("./modules/calendar/calendar.controller");
const docCtrl      = require("./modules/documents/documents.controller");
const patCtrl      = require("./modules/patients/patients.controller");
const auditSvc     = require("./modules/audit/audit.service");

const router = Router();

// ── Health check ─────────────────────────────────────────────
router.get("/health", (_req, res) => res.json({
  status:    "ok",
  service:   "IPS Salud Vida API",
  timestamp: new Date().toISOString(),
}));

// ── Webhook Meta (sin auth, verificado por token) ─────────────
router.get( "/webhook",      webhookCtrl.verify);
router.post("/webhook",      webhookCtrl.handle);

// ── Auth ──────────────────────────────────────────────────────
router.post("/api/auth/login",           authCtrl.login);
router.get( "/api/auth/me",              requireAuth, trackAcceso, authCtrl.me);
router.post("/api/auth/change-password", requireAuth, authCtrl.changePassword);

// ── Chat / Handoff ────────────────────────────────────────────
router.patch("/api/chat/toggle-status",  requireAuth, trackAcceso, chatCtrl.toggleStatus);
router.get(  "/api/chat/status/:phone",  requireAuth, chatCtrl.getStatus);
router.post( "/api/chat/send",           requireAuth, chatCtrl.sendMessage);
router.get(  "/api/chat/last-messages",   requireAuth, chatCtrl.getLastMessages);
router.get(  "/api/chat/history/:phone", requireAuth, chatCtrl.getHistory);
router.post( "/api/chat/request-asesor",  requireAuth, chatCtrl.requestAsesor);
router.get(  "/api/chat/pending-asesor",  requireAuth, chatCtrl.getPendingAsesor);
router.post( "/api/chat/bot-message",    requireAuth, chatCtrl.saveBotMessage);

// ── Calendario ────────────────────────────────────────────────
router.get(    "/api/calendar/slots",                    requireAuth, calCtrl.getSlots);
router.post(   "/api/calendar/appointments",             requireAuth, calCtrl.createAppointment);
router.get(    "/api/calendar/appointments/:pacienteId", requireAuth, calCtrl.getByPaciente);
router.patch(  "/api/calendar/appointments/:id/status",  requireAuth, calCtrl.updateStatus);
router.delete( "/api/calendar/appointments/:id",         requireAuth, calCtrl.cancelAppointment);

// ── Documentos / IA ───────────────────────────────────────────
router.post("/api/process-document",          requireAuth, docCtrl.processDocument);
router.post("/api/process-document/validate", requireAuth, docCtrl.validateDocument);
router.get( "/api/process-document/logs",     requireAuth, docCtrl.getLogs);

// ── Pacientes ─────────────────────────────────────────────────
router.get(  "/api/patients",                requireAuth, patCtrl.list);
router.get(  "/api/patients/by-phone/:phone",requireAuth, patCtrl.getByPhone);
router.get(  "/api/patients/:id",            requireAuth, patCtrl.getById);
router.patch("/api/patients/:id",            requireAuth, patCtrl.update);

// ── Auditoría (solo ADMIN) ────────────────────────────────────
router.get("/api/audit/logs", requireAuth, requireRol("ADMIN"), async (req, res) => {
  try {
    const result = await auditSvc.obtenerLogs({
      usuarioId: req.query.usuarioId,
      accion:    req.query.accion,
      desde:     req.query.desde,
      hasta:     req.query.hasta,
      page:      parseInt(req.query.page)  || 1,
      limit:     parseInt(req.query.limit) || 50,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Gestión de usuarios (solo ADMIN) ─────────────────────────
router.post("/api/usuarios", requireAuth, requireRol("ADMIN"), async (req, res) => {
  try {
    const bcrypt   = require("bcrypt");
    const { bcryptRounds } = require("./config/env");
    const prisma   = require("./config/database");
    const { nombre, email, password, rol } = req.body;

    if (!nombre || !email || !password) {
      return res.status(400).json({ error: "nombre, email y password son obligatorios." });
    }

    const hash   = await bcrypt.hash(password, bcryptRounds);
    const usuario = await prisma.usuario.create({
      data:   { nombre, email, passwordHash: hash, rol: rol || "ASESOR" },
      select: { id: true, nombre: true, email: true, rol: true, createdAt: true },
    });

    return res.status(201).json({ usuario });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "El email ya está registrado." });
    return res.status(500).json({ error: err.message });
  }
});

router.get("/api/usuarios", requireAuth, requireRol("ADMIN"), async (req, res) => {
  const prisma = require("./config/database");
  const lista  = await prisma.usuario.findMany({
    select: { id: true, nombre: true, email: true, rol: true, activo: true, ultimoAcceso: true },
  });
  return res.json({ usuarios: lista });
});

// ── Sedes (públicas para el bot) ──────────────────────────────
router.get("/api/sedes", async (_req, res) => {
  const prisma = require("./config/database");
  const sedes  = await prisma.sede.findMany({
    where:   { activa: true },
    include: { horarios: true },
  });
  return res.json({ sedes });
});

module.exports = router;
module.exports.setHandleBot = webhookCtrl.setHandleBot;
