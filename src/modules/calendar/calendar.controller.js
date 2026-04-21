// src/modules/calendar/calendar.controller.js
// ============================================================
//  GET  /api/calendar/slots        — slots disponibles
//  POST /api/calendar/appointments — crear cita
//  GET  /api/calendar/appointments/:pacienteId — historial
//  PATCH /api/calendar/appointments/:id/status — cambiar estado
//  DELETE /api/calendar/appointments/:id        — cancelar
// ============================================================

"use strict";

const calSvc   = require("./calendar.service");
const auditSvc = require("../audit/audit.service");
const prisma   = require("../../config/database");

// GET /api/calendar/slots?fecha=YYYY-MM-DD&especialidad=X&sede=sede-centro
async function getSlots(req, res) {
  try {
    const { fecha, especialidad, sede } = req.query;
    if (!fecha || !especialidad || !sede) {
      return res.status(400).json({ error: "fecha, especialidad y sede son obligatorios." });
    }
    // Validar formato de fecha
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ error: "Formato de fecha inválido. Use YYYY-MM-DD." });
    }

    const slots = await calSvc.getAvailableSlots(fecha, especialidad, sede);
    return res.json({ fecha, especialidad, sede, total: slots.length, slots });
  } catch (err) {
    console.error("Error getSlots:", err.message);
    return res.status(err.message.includes("no encontrada") ? 404 : 500)
              .json({ error: err.message });
  }
}

// POST /api/calendar/appointments
async function createAppointment(req, res) {
  try {
    const { pacienteId, sedeSlug, especialidad, fechaInicio, fechaFin, motivoConsulta } = req.body;

    if (!pacienteId || !sedeSlug || !especialidad || !fechaInicio || !fechaFin) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const cita = await calSvc.createAppointment({
      pacienteId,
      sedeSlug,
      especialidad,
      fechaInicio,
      fechaFin,
      asesorId:       req.usuario?.id || null,
      motivoConsulta,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario?.id,
      accion:      "CREAR_CITA",
      entidadTipo: "Cita",
      entidadId:   cita.id,
      detalle:     { especialidad, fechaInicio, sedeSlug, pacienteId },
      req,
    });

    return res.status(201).json({ cita });
  } catch (err) {
    if (err.message.startsWith("SLOT_OCUPADO")) {
      return res.status(409).json({ error: err.message.replace("SLOT_OCUPADO: ", "") });
    }
    console.error("Error createAppointment:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

// GET /api/calendar/appointments/:pacienteId
async function getByPaciente(req, res) {
  try {
    const { pacienteId } = req.params;
    const { page, limit } = req.query;
    const result = await calSvc.getAppointmentsByPaciente(pacienteId, {
      page:  parseInt(page)  || 1,
      limit: parseInt(limit) || 20,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "VER_HISTORIA",
      entidadTipo: "Paciente",
      entidadId:   pacienteId,
      req,
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// DELETE /api/calendar/appointments/:id
async function cancelAppointment(req, res) {
  try {
    const { id } = req.params;
    const cita   = await calSvc.cancelAppointment(id, req.usuario.id);

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "CANCELAR_CITA",
      entidadTipo: "Cita",
      entidadId:   id,
      detalle:     { estadoAnterior: "PENDIENTE/CONFIRMADA" },
      req,
    });

    return res.json({ message: "Cita cancelada.", cita });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// PATCH /api/calendar/appointments/:id/status
async function updateStatus(req, res) {
  try {
    const { id }     = req.params;
    const { estado } = req.body;
    const VALID      = ["CONFIRMADA", "COMPLETADA", "NO_ASISTIO", "CANCELADA"];

    if (!VALID.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido. Valores permitidos: ${VALID.join(", ")}` });
    }

    const cita = await prisma.cita.update({ where: { id }, data: { estado } });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      estado === "CANCELADA" ? "CANCELAR_CITA" : "CONFIRMAR_CITA",
      entidadTipo: "Cita",
      entidadId:   id,
      detalle:     { nuevoEstado: estado },
      req,
    });

    return res.json({ cita });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { getSlots, createAppointment, getByPaciente, cancelAppointment, updateStatus };
