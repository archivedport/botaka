// src/modules/audit/audit.service.js
// ============================================================
//  Servicio de auditoría: registra cada acción sensible en BD.
//  Se llama de forma explícita desde los controllers,
//  no como middleware automático (mayor control).
// ============================================================

"use strict";

const prisma = require("../../config/database");

/**
 * Registra una acción de auditoría.
 *
 * @param {object} opts
 * @param {string}  opts.usuarioId
 * @param {string}  opts.accion        — valor del enum AccionAuditoria
 * @param {string}  [opts.entidadTipo] — "Cita", "Paciente", etc.
 * @param {string}  [opts.entidadId]
 * @param {object}  [opts.detalle]     — snapshot / payload relevante
 * @param {object}  [opts.req]         — Express request para IP y UA
 */
async function registrar({ usuarioId, accion, entidadTipo, entidadId, detalle, req }) {
  try {
    await prisma.logAuditoria.create({
      data: {
        usuarioId,
        accion,
        entidadTipo,
        entidadId,
        detalle:   detalle   || undefined,
        ip:        req?.ip   || req?.headers?.["x-forwarded-for"] || null,
        userAgent: req?.headers?.["user-agent"] || null,
      },
    });
  } catch (err) {
    // La auditoría nunca debe romper el flujo principal
    console.error("⚠️  Error registrando auditoría:", err.message);
  }
}

/**
 * Consulta el log de auditoría con paginación.
 * Solo accesible para ADMIN.
 */
async function obtenerLogs({ usuarioId, accion, desde, hasta, page = 1, limit = 50 }) {
  const where = {};
  if (usuarioId) where.usuarioId   = usuarioId;
  if (accion)    where.accion      = accion;
  if (desde || hasta) {
    where.createdAt = {};
    if (desde) where.createdAt.gte = new Date(desde);
    if (hasta) where.createdAt.lte = new Date(hasta);
  }

  const [total, logs] = await Promise.all([
    prisma.logAuditoria.count({ where }),
    prisma.logAuditoria.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip:    (page - 1) * limit,
      take:    limit,
      include: { usuario: { select: { nombre: true, email: true } } },
    }),
  ]);

  return { total, page, limit, pages: Math.ceil(total / limit), logs };
}

module.exports = { registrar, obtenerLogs };
