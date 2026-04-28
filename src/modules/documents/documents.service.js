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

// ── Prompt de control de calidad ─────────────────────────────
// Gemini evalúa si la imagen es procesable ANTES de hacer la
// extracción completa. Evita pasar imágenes borrosas o inválidas
// al pipeline de IA y ahorra tokens y tiempo.

const QUALITY_PROMPT = `Analiza esta imagen y determina si es lo suficientemente clara y legible para extraer datos de un documento colombiano (cédula, carnet EPS, orden médica, resultado de laboratorio, etc.).

Responde ÚNICAMENTE con un JSON válido, sin bloques de código ni texto adicional:
{
  "legible": true o false,
  "tipo": "cédula | carnet_eps | orden_medica | resultado_lab | foto_personal | no_documento | otro",
  "problema": "descripción breve del problema en español, o null si está legible"
}

Considera NO legible si:
- Está borrosa o desenfocada
- Muy oscura o sobreexpuesta
- El documento está cortado (faltan bordes)
- El ángulo es mayor a 30° (muy inclinada)
- La resolución no permite leer texto
- No es un documento (foto de persona, paisaje, etc.)`;

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
  // Intentar primero con gemini-1.5-flash, si falla con 404 usar gemini-pro-vision
  const MODELOS = [
    gemini.model,                     // env: "gemini-1.5-flash"
    "gemini-1.5-flash-latest",        // alias al más reciente
    "gemini-1.5-flash-001",           // versión específica estable
    "gemini-2.0-flash",               // sucesor en caso de deprecación
  ];

  let ultimoError = null;

  for (const modelo of MODELOS) {
    const GEMINI_URL =
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${gemini.apiKey}`;

    console.log(`🤖 Gemini → modelo: ${modelo} | mimeType: ${mimeType} | base64: ${base64?.length || 0} chars`);

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

    try {
      const res = await axios.post(GEMINI_URL, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      });

      const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!texto) throw new Error("Gemini no devolvió contenido.");

      console.log(`✅ Gemini OK con modelo: ${modelo}`);
      return texto;

    } catch (err) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data || err.message);
      console.error(`❌ Gemini ${modelo} → ${status}: ${detail}`);
      ultimoError = err;

      // Solo reintentar en 404 (modelo no existe) o 429 (rate limit)
      if (status !== 404 && status !== 429) throw err;
    }
  }

  throw ultimoError;
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
 * Verifica la calidad de una imagen antes de procesarla.
 * Llama a Gemini con un prompt ligero (más rápido y barato que la extracción completa).
 *
 * @param {string} base64   — imagen en base64
 * @param {string} mimeType — tipo MIME (image/jpeg, etc.)
 * @returns {{ legible: boolean, tipo: string, problema: string|null }}
 */
async function verificarCalidadDocumento(base64, mimeType) {
  try {
    // Usar el mismo modelo que analizarConGemini (con fallback)
    const MODELOS_Q = [gemini.model, "gemini-1.5-flash-latest", "gemini-2.0-flash"];
    let resTexto = "";

    for (const modelo of MODELOS_Q) {
      const GEMINI_URL =
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${gemini.apiKey}`;
      try {
        const res = await axios.post(GEMINI_URL, {
          contents: [{
            parts: [
              { text: QUALITY_PROMPT },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
        }, { headers: { "Content-Type": "application/json" }, timeout: 15000 });

        resTexto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        break; // éxito, salir del loop
      } catch (e) {
        if (e.response?.status !== 404 && e.response?.status !== 429) throw e;
      }
    }

    return parsearRespuesta(resTexto);
  } catch (err) {
    // Si falla la verificación, asumir legible para no bloquear al paciente
    console.warn("⚠️ verificarCalidad falló, asumiendo legible:", err.message);
    return { legible: true, tipo: "desconocido", problema: null };
  }
}

/**
 * Procesa un documento recibido por WhatsApp.
 *
 * @param {object} opts
 * @param {string}  opts.mediaId     — ID del media de Meta
 * @param {string}  [opts.pacienteId]
 * @param {string}  [opts.asesorId]
 * @returns {object} { logId, datos, confianza }
 */
async function procesarDocumento({ mediaId, base64: b64, mimeType: mt, pacienteId, asesorId }) {
  // 1. Descargar imagen de Meta (solo si no se pasó ya descargada)
  //    Cuando viene de procesarDocumentoAutomatico ya tenemos los datos,
  //    así evitamos descargar dos veces la misma imagen.
  let base64 = b64, mimeType = mt;
  if (!base64) {
    const dl  = await descargarMediaMeta(mediaId);
    base64    = dl.base64;
    mimeType  = dl.mimeType;
  }

  console.log(`📄 procesarDocumento: base64=${!!base64} mimeType=${mimeType} mediaId=${mediaId}`);

  // 2. Analizar con Gemini (extracción completa)
  //    El quality check se hace en webhook.controller para el auto-proceso,
  //    y en bot.js para el flujo guiado de agendamiento.
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

module.exports = { procesarDocumento, validarDocumento, verificarCalidadDocumento, descargarMediaMeta };
