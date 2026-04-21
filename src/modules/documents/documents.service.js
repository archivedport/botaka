// src/modules/documents/documents.service.js
// ============================================================
//  Pipeline de IA para procesamiento de documentos médicos.
//
//  Flujo:
//  1. Recibir media_id de Meta
//  2. Descargar la imagen via Meta Graph API
//  3. Enviar a Gemini 1.5 Flash con prompt estructurado
//  4. Parsear respuesta JSON
//  5. Guardar en LogIA para auditoría
//  6. Devolver JSON estructurado al asesor para validación
// ============================================================

"use strict";

const axios  = require("axios");
const prisma = require("../../config/database");
const { meta, gemini } = require("../../config/env");

// ── Prompt de extracción ──────────────────────────────────────

const EXTRACTION_PROMPT = `Analiza esta imagen de un documento médico colombiano.
Extrae los datos y responde ÚNICAMENTE con un JSON válido sin bloques de código, con esta estructura exacta:
{
  "tipoDocumento": "CEDULA | CARNET_EPS | ORDEN_MEDICA | RESULTADO_LAB | OTRO",
  "nombre": "Nombre completo o null",
  "cedula": "Número de cédula o null",
  "eps": "Nombre de la EPS o null",
  "vigencia": "Fecha de vigencia en formato YYYY-MM-DD o null",
  "numeroAfiliacion": "Número de afiliación EPS o null",
  "fechaExpedicion": "Fecha expedición documento YYYY-MM-DD o null",
  "observaciones": "Cualquier dato relevante adicional o null",
  "confianza": 0.0
}
Si no puedes leer un campo, usa null. El campo confianza va de 0.0 a 1.0.
No incluyas texto fuera del JSON.`;

// ── Descargar media de Meta ───────────────────────────────────

async function descargarMediaMeta(mediaId) {
  // Paso 1: obtener URL temporal del archivo
  const urlRes = await axios.get(
    `${meta.baseUrl()}/${mediaId}`,
    { headers: { Authorization: `Bearer ${meta.token}` } }
  );

  const mediaUrl = urlRes.data?.url;
  if (!mediaUrl) throw new Error("No se pudo obtener la URL del media.");

  // Paso 2: descargar el archivo como buffer
  const fileRes = await axios.get(mediaUrl, {
    headers:      { Authorization: `Bearer ${meta.token}` },
    responseType: "arraybuffer",
  });

  const mimeType  = urlRes.data?.mime_type || "image/jpeg";
  const buffer    = Buffer.from(fileRes.data);
  const base64    = buffer.toString("base64");

  return { base64, mimeType, size: buffer.length };
}

// ── Enviar a Gemini ───────────────────────────────────────────

async function analizarConGemini(base64, mimeType) {
  const GEMINI_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${gemini.model}:generateContent?key=${gemini.apiKey}`;

  const payload = {
    contents: [{
      parts: [
        { text: EXTRACTION_PROMPT },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ],
    }],
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 1024,
    },
  };

  const res = await axios.post(GEMINI_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error("Gemini no devolvió contenido.");

  return texto;
}

// ── Parsear respuesta de Gemini ───────────────────────────────

function parsearRespuesta(texto) {
  try {
    // Limpiar posibles bloques de código que Gemini incluya a veces
    const limpio = texto
      .replace(/```json\n?/gi, "")
      .replace(/```\n?/g, "")
      .trim();
    return JSON.parse(limpio);
  } catch {
    throw new Error("La respuesta de Gemini no es un JSON válido.");
  }
}

// ── Función principal ─────────────────────────────────────────

/**
 * Procesa un documento recibido por WhatsApp.
 *
 * @param {object} opts
 * @param {string}  opts.mediaId     — ID del media de Meta
 * @param {string}  [opts.pacienteId]
 * @param {string}  [opts.asesorId]
 * @returns {object} { logId, datos, confianza }
 */
async function procesarDocumento({ mediaId, pacienteId, asesorId }) {
  // 1. Descargar imagen de Meta
  const { base64, mimeType } = await descargarMediaMeta(mediaId);

  // 2. Analizar con Gemini
  const textoGemini = await analizarConGemini(base64, mimeType);

  // 3. Parsear JSON
  const parsed = parsearRespuesta(textoGemini);

  // 4. Guardar en LogIA
  const log = await prisma.logIA.create({
    data: {
      mediaId,
      pacienteId:     pacienteId || null,
      asesorId:       asesorId   || null,
      tipoDocumento:  parsed.tipoDocumento || "OTRO",
      resultadoRaw:   { texto: textoGemini },
      resultadoParsed: parsed,
      confianza:      typeof parsed.confianza === "number" ? parsed.confianza : null,
    },
  });

  // 5. Si hay paciente y confianza alta, sugerir actualización automática
  let sugerenciaActualizacion = null;
  if (pacienteId && parsed.confianza >= 0.85) {
    sugerenciaActualizacion = {
      nombre:    parsed.nombre     || undefined,
      documento: parsed.cedula     || undefined,
      eps:       parsed.eps        || undefined,
      vigenciaEPS: parsed.vigencia
        ? new Date(parsed.vigencia)
        : undefined,
    };
  }

  return {
    logId:                 log.id,
    datos:                 parsed,
    confianza:             parsed.confianza || 0,
    sugerenciaActualizacion,
    requiereValidacion:    (parsed.confianza || 0) < 0.85,
  };
}

/**
 * El asesor valida y confirma los datos extraídos por IA.
 * Opcionalmente actualiza el perfil del paciente.
 */
async function validarDocumento({ logId, asesorId, datosValidados, actualizarPaciente }) {
  const log = await prisma.logIA.findUnique({ where: { id: logId } });
  if (!log) throw new Error("Log de IA no encontrado.");

  // Marcar como validado
  await prisma.logIA.update({
    where: { id: logId },
    data:  { validadoPor: asesorId, validadoEn: new Date() },
  });

  // Actualizar paciente si se solicita y hay pacienteId
  if (actualizarPaciente && log.pacienteId && datosValidados) {
    const update = {};
    if (datosValidados.nombre)    update.nombre    = datosValidados.nombre;
    if (datosValidados.cedula)    update.documento  = datosValidados.cedula;
    if (datosValidados.eps)       update.eps        = datosValidados.eps;
    if (datosValidados.vigencia)  update.vigenciaEPS = new Date(datosValidados.vigencia);

    if (Object.keys(update).length) {
      await prisma.paciente.update({
        where: { id: log.pacienteId },
        data:  update,
      });
    }
  }

  return { ok: true, logId };
}

module.exports = { procesarDocumento, validarDocumento };
