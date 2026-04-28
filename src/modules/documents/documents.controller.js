// src/modules/documents/documents.controller.js
// ============================================================
//  POST /api/process-document       — analizar documento con IA
//  POST /api/process-document/validate — asesor confirma datos
//  GET  /api/process-document/logs  — historial de logs IA
// ============================================================

"use strict";

const docSvc   = require("./documents.service");
const auditSvc = require("../audit/audit.service");
const prisma   = require("../../config/database");

// POST /api/process-document
async function processDocument(req, res) {
  try {
    const { mediaId, pacienteId } = req.body;

    if (!mediaId) {
      return res.status(400).json({ error: "mediaId es obligatorio." });
    }

    const resultado = await docSvc.procesarDocumento({
      mediaId,
      base64:        req.body.base64        || null,
      mimeType:      req.body.mimeType      || null,
      cloudinaryUrl: req.body.cloudinaryUrl || null,
      pacienteId:    pacienteId || null,
      asesorId:      req.usuario.id,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "PROCESAR_DOCUMENTO",
      entidadTipo: "LogIA",
      entidadId:   resultado.logId,
      detalle:     { mediaId, confianza: resultado.confianza },
      req,
    });

    return res.json(resultado);
  } catch (err) {
    console.error("Error processDocument:", err.message);
    const status = err.message.includes("URL") || err.message.includes("JSON") ? 422 : 500;
    return res.status(status).json({ error: err.message });
  }
}

// POST /api/process-document/validate
async function validateDocument(req, res) {
  try {
    const { logId, datosValidados, actualizarPaciente } = req.body;

    if (!logId) return res.status(400).json({ error: "logId es obligatorio." });

    const resultado = await docSvc.validarDocumento({
      logId,
      asesorId:          req.usuario.id,
      datosValidados:    datosValidados    || {},
      actualizarPaciente: actualizarPaciente !== false,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "PROCESAR_DOCUMENTO",
      entidadTipo: "LogIA",
      entidadId:   logId,
      detalle:     { validado: true, actualizarPaciente },
      req,
    });

    return res.json(resultado);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// GET /api/process-document/logs?pacienteId=&page=&limit=
async function getLogs(req, res) {
  try {
    const { pacienteId, page = 1, limit = 20 } = req.query;
    const where = {};
    if (pacienteId) where.pacienteId = pacienteId;

    const [total, logs] = await Promise.all([
      prisma.logIA.count({ where }),
      prisma.logIA.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip:    (parseInt(page) - 1) * parseInt(limit),
        take:    parseInt(limit),
        include: {
          paciente: { select: { nombre: true, phone: true } },
          asesor:   { select: { nombre: true } },
        },
      }),
    ]);

    return res.json({ total, page: parseInt(page), limit: parseInt(limit), logs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { processDocument, validateDocument, getLogs };
