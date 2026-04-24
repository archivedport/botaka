// src/modules/calendar/calendar.controller.js — v2
// Agrega: GET /api/calendar/events (rango de fechas para la vista calendario)

"use strict";

const calSvc   = require("./calendar.service");
const auditSvc = require("../audit/audit.service");
const prisma   = require("../../config/database");

// GET /api/calendar/slots
async function getSlots(req, res) {
  try {
    const { fecha, especialidad, sede } = req.query;
    if (!fecha || !especialidad || !sede)
      return res.status(400).json({ error: "fecha, especialidad y sede son obligatorios." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha))
      return res.status(400).json({ error: "Formato de fecha inválido. Use YYYY-MM-DD." });

    const slots = await calSvc.getAvailableSlots(fecha, especialidad, sede);
    return res.json({ fecha, especialidad, sede, total: slots.length, slots });
  } catch (err) {
    return res.status(err.message.includes("no encontrada") ? 404 : 500).json({ error: err.message });
  }
}

// ── GET /api/calendar/events ─────────────────────────────────
//  Devuelve todas las citas en un rango de fechas.
//  Query: desde=YYYY-MM-DD, hasta=YYYY-MM-DD, sedeSlug?, especialidad?
//  Usado por la vista de calendario del panel web.
async function getEvents(req, res) {
  try {
    const { desde, hasta, sedeSlug, especialidad } = req.query;

    if (!desde || !hasta)
      return res.status(400).json({ error: "desde y hasta son obligatorios." });

    const where = {
      fechaInicio: {
        gte: new Date(`${desde}T00:00:00`),
        lte: new Date(`${hasta}T23:59:59`),
      },
    };

    if (especialidad) where.especialidad = especialidad;

    if (sedeSlug) {
      const sede = await prisma.sede.findUnique({ where: { slug: sedeSlug } });
      if (sede) where.sedeId = sede.id;
    }

    const citas = await prisma.cita.findMany({
      where,
      orderBy: { fechaInicio: "asc" },
      include: {
        paciente: { select: { id: true, nombre: true, phone: true, eps: true, documento: true } },
        sede:     { select: { id: true, nombre: true, slug: true } },
        asesor:   { select: { nombre: true } },
      },
    });

    return res.json({ total: citas.length, citas });
  } catch (err) {
    console.error("Error getEvents:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/calendar/appointments
async function createAppointment(req, res) {
  try {
    const { pacienteId, sedeSlug, especialidad, fechaInicio, fechaFin, motivoConsulta } = req.body;

    if (!pacienteId || !sedeSlug || !especialidad || !fechaInicio || !fechaFin)
      return res.status(400).json({ error: "Faltan campos obligatorios." });

    const cita = await calSvc.createAppointment({
      pacienteId, sedeSlug, especialidad, fechaInicio, fechaFin,
      asesorId: req.usuario?.id || null, motivoConsulta,
    });

    await auditSvc.registrar({
      usuarioId: req.usuario?.id, accion: "CREAR_CITA",
      entidadTipo: "Cita", entidadId: cita.id,
      detalle: { especialidad, fechaInicio, sedeSlug, pacienteId }, req,
    });

    // Emitir evento Socket.io para actualización en tiempo real del calendario
    try {
      const { getIO } = require("../../socket/socket");
      getIO().to("asesores").emit("calendar:cita_creada", { cita });
    } catch {}

    return res.status(201).json({ cita });
  } catch (err) {
    if (err.message.startsWith("SLOT_OCUPADO"))
      return res.status(409).json({ error: err.message.replace("SLOT_OCUPADO: ", "") });
    return res.status(400).json({ error: err.message });
  }
}

// GET /api/calendar/appointments/:pacienteId
async function getByPaciente(req, res) {
  try {
    const result = await calSvc.getAppointmentsByPaciente(req.params.pacienteId, {
      page:  parseInt(req.query.page)  || 1,
      limit: parseInt(req.query.limit) || 20,
    });
    await auditSvc.registrar({
      usuarioId: req.usuario.id, accion: "VER_HISTORIA",
      entidadTipo: "Paciente", entidadId: req.params.pacienteId, req,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// DELETE /api/calendar/appointments/:id
async function cancelAppointment(req, res) {
  try {
    const cita = await calSvc.cancelAppointment(req.params.id, req.usuario.id);
    await auditSvc.registrar({
      usuarioId: req.usuario.id, accion: "CANCELAR_CITA",
      entidadTipo: "Cita", entidadId: req.params.id,
      detalle: { estadoAnterior: "PENDIENTE/CONFIRMADA" }, req,
    });
    // Notificar calendario en tiempo real
    try {
      const { getIO } = require("../../socket/socket");
      getIO().to("asesores").emit("calendar:cita_actualizada", { cita });
    } catch {}
    return res.json({ message: "Cita cancelada.", cita });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// PATCH /api/calendar/appointments/:id/status
async function updateStatus(req, res) {
  try {
    const VALID = ["CONFIRMADA", "COMPLETADA", "NO_ASISTIO", "CANCELADA"];
    const { estado } = req.body;

    if (!VALID.includes(estado))
      return res.status(400).json({ error: `Estado inválido. Valores: ${VALID.join(", ")}` });

    const cita = await prisma.cita.update({
      where: { id: req.params.id },
      data:  { estado },
      include: {
        paciente: { select: { nombre: true, phone: true } },
        sede:     { select: { nombre: true } },
      },
    });

    await auditSvc.registrar({
      usuarioId: req.usuario.id,
      accion: estado === "CANCELADA" ? "CANCELAR_CITA" : "CONFIRMAR_CITA",
      entidadTipo: "Cita", entidadId: req.params.id,
      detalle: { nuevoEstado: estado }, req,
    });

    // Notificar calendario en tiempo real
    try {
      const { getIO } = require("../../socket/socket");
      getIO().to("asesores").emit("calendar:cita_actualizada", { cita });
    } catch {}

    return res.json({ cita });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { getSlots, getEvents, createAppointment, getByPaciente, cancelAppointment, updateStatus };
