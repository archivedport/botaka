// src/modules/solicitudes/solicitudes.controller.js
// ============================================================
//  Controlador de Solicitudes de Citas
//
//  GET   /api/solicitudes          — lista de citas PENDIENTE
//  PATCH /api/solicitudes/:id/aprobar — confirmar cita
//  PATCH /api/solicitudes/:id/denegar — cancelar cita
//
//  Todos los endpoints requieren JWT (requireAuth en routes.js).
// ============================================================

"use strict";

const solSvc   = require("./solicitudes.service");
const auditSvc = require("../audit/audit.service");

// ── GET /api/solicitudes ─────────────────────────────────────
//  Query params: page, limit
async function list(req, res) {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;

    const result = await solSvc.getSolicitudes({ page, limit });
    return res.json(result);
  } catch (err) {
    console.error("Error list solicitudes:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── PATCH /api/solicitudes/:id/aprobar ───────────────────────
//  Body: { nota? }
async function aprobar(req, res) {
  try {
    const { nota = "" } = req.body;

    const cita = await solSvc.aprobarSolicitud(req.params.id, {
      asesorId: req.usuario.id,
      nota,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "CONFIRMAR_CITA",
      entidadTipo: "Cita",
      entidadId:   req.params.id,
      detalle:     {
        accion:        "APROBAR_SOLICITUD",
        especialidad:  cita.especialidad,
        pacienteId:    cita.paciente?.id,
        nota:          nota || null,
      },
      req,
    });

    return res.json({
      ok:      true,
      message: "Cita aprobada. El paciente ha sido notificado por WhatsApp.",
      cita,
    });
  } catch (err) {
    console.error("Error aprobar solicitud:", err.message);
    const status = err.message.includes("no encontrada") ? 404
      : err.message.includes("ya fue procesada")        ? 409
      : 500;
    return res.status(status).json({ error: err.message });
  }
}

// ── PATCH /api/solicitudes/:id/denegar ───────────────────────
//  Body: { nota? }
async function denegar(req, res) {
  try {
    const { nota = "" } = req.body;

    const cita = await solSvc.denegarSolicitud(req.params.id, {
      asesorId: req.usuario.id,
      nota,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "CANCELAR_CITA",
      entidadTipo: "Cita",
      entidadId:   req.params.id,
      detalle:     {
        accion:       "DENEGAR_SOLICITUD",
        especialidad: cita.especialidad,
        pacienteId:   cita.paciente?.id,
        nota:         nota || null,
      },
      req,
    });

    return res.json({
      ok:      true,
      message: "Cita denegada. El paciente ha sido notificado por WhatsApp.",
      cita,
    });
  } catch (err) {
    console.error("Error denegar solicitud:", err.message);
    const status = err.message.includes("no encontrada") ? 404
      : err.message.includes("ya fue procesada")        ? 409
      : 500;
    return res.status(status).json({ error: err.message });
  }
}

module.exports = { list, aprobar, denegar };