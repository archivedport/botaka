// src/modules/documents/documents.controller.js
// ============================================================
//  POST /api/process-document          — analizar documento con IA
//  POST /api/process-document/validate — asesor confirma datos
//  GET  /api/process-document/logs     — historial de logs IA
//  GET  /api/process-document/stats    — dashboard de costos IA (ADMIN)
// ============================================================

"use strict";

const docSvc   = require("./documents.service");
const auditSvc = require("../audit/audit.service");
const prisma   = require("../../config/database");

// POST /api/process-document
async function processDocument(req, res) {
  try {
    const { mediaId, pacienteId } = req.body;
    if (!mediaId) return res.status(400).json({ error: "mediaId es obligatorio." });

    const resultado = await docSvc.procesarDocumento({
      mediaId,
      base64:        req.body.base64        || null,
      mimeType:      req.body.mimeType      || null,
      cloudinaryUrl: req.body.cloudinaryUrl || null,
      pacienteId:    pacienteId || null,
      asesorId:      req.usuario.id,
      paso:          req.body.paso          || "default",
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
      asesorId:           req.usuario.id,
      datosValidados:     datosValidados    || {},
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

// GET /api/process-document/stats  (solo ADMIN)
// Agrega costos desde resultadoRaw.tokensInput/Output/costUSD
async function getStats(req, res) {
  try {
    // Traer todos los logs — solo los campos necesarios
    const logs = await prisma.logIA.findMany({
      select: { id: true, tipoDocumento: true, resultadoRaw: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    let totalInput   = 0;
    let totalOutput  = 0;
    let totalCostUSD = 0;
    let conTracking  = 0;   // logs que tienen datos de tokens

    const byType = {};   // { CEDULA: { count, cost }, ... }
    const byDay  = {};   // { "2026-05-01": { count, cost }, ... }

    const now       = new Date();
    const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    let costMesActual = 0;
    let countMesActual = 0;

    for (const log of logs) {
      const raw  = (log.resultadoRaw && typeof log.resultadoRaw === "object") ? log.resultadoRaw : {};
      const ti   = Number(raw.tokensInput)  || 0;
      const to   = Number(raw.tokensOutput) || 0;
      const cost = Number(raw.costUSD)      || 0;

      if (ti > 0 || cost > 0) conTracking++;

      totalInput   += ti;
      totalOutput  += to;
      totalCostUSD += cost;

      // Por tipo
      const tipo = log.tipoDocumento || "OTRO";
      if (!byType[tipo]) byType[tipo] = { count: 0, costUSD: 0 };
      byType[tipo].count++;
      byType[tipo].costUSD += cost;

      // Por día
      const day = log.createdAt.toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { count: 0, costUSD: 0 };
      byDay[day].count++;
      byDay[day].costUSD += cost;

      // Mes actual
      const logMes = log.createdAt.toISOString().slice(0, 7);
      if (logMes === mesActual) {
        costMesActual  += cost;
        countMesActual++;
      }
    }

    // Proyección mensual (días transcurridos del mes actual)
    const diasDelMes      = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const diaActual       = now.getDate();
    const proyMensual     = diaActual > 0
      ? (costMesActual / diaActual) * diasDelMes
      : 0;
    const proyAnual       = proyMensual * 12;

    // Últimos 30 días para el gráfico
    const treintaDias = [];
    for (let i = 29; i >= 0; i--) {
      const d  = new Date(now);
      d.setDate(d.getDate() - i);
      const dk = d.toISOString().slice(0, 10);
      treintaDias.push({
        dia:    dk,
        count:  byDay[dk]?.count   || 0,
        costUSD: byDay[dk]?.costUSD || 0,
      });
    }

    return res.json({
      totalLlamadas:   logs.length,
      conTracking,
      totalTokensInput:  totalInput,
      totalTokensOutput: totalOutput,
      totalCostUSD,
      costMesActual,
      countMesActual,
      proyMensual,
      proyAnual,
      byType,
      ultimos30Dias: treintaDias,
      modelo:        "claude-haiku-4-5-20251001",
      precioInput:   "0.80 / M tokens",
      precioOutput:  "4.00 / M tokens",
    });
  } catch (err) {
    console.error("getStats error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { processDocument, validateDocument, getLogs, getStats };
