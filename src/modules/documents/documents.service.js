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
const { meta, gemini, anthropic } = require("../../config/env");

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

/**
 * Analiza un documento con Claude Haiku (visión).
 * Anthropic API v1/messages — sin problemas de cuota.
 */
async function analizarConGemini(base64, mimeType) {
  console.log(`🤖 Claude Haiku → mimeType: ${mimeType} | base64: ${base64?.length || 0} chars`);

  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model:      anthropic.model,
      max_tokens: 1024,
      messages: [{
        role:    "user",
        content: [
          {
            type:   "image",
            source: { type: "base64", media_type: mimeType, data: base64 },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      }],
    },
    {
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         anthropic.apiKey,
        "anthropic-version": "2023-06-01",
      },
      timeout: 30000,
    }
  );

  const texto = res.data?.content?.[0]?.text;
  if (!texto) throw new Error("Claude no devolvió contenido.");

  console.log("✅ Claude OK");
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
 * Verifica la calidad de una imagen antes de procesarla.
 * Llama a Gemini con un prompt ligero (más rápido y barato que la extracción completa).
 *
 * @param {string} base64   — imagen en base64
 * @param {string} mimeType — tipo MIME (image/jpeg, etc.)
 * @returns {{ legible: boolean, tipo: string, problema: string|null }}
 */
async function verificarCalidadDocumento(base64, mimeType) {
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      anthropic.model,
        max_tokens: 256,
        messages: [{
          role:    "user",
          content: [
            {
              type:   "image",
              source: { type: "base64", media_type: mimeType, data: base64 },
            },
            { type: "text", text: QUALITY_PROMPT },
          ],
        }],
      },
      {
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         anthropic.apiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: 15000,
      }
    );

    const texto = res.data?.content?.[0]?.text || "";
    return parsearRespuesta(texto);
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
/**
 * Verifica la calidad de un documento y lo registra en LogIA.
 * Nueva lógica (v2): Solo verificar calidad — NO extraer datos.
 * El asesor ve la imagen original en solicitudes.html.
 */
async function procesarDocumento({ mediaId, base64: b64, mimeType: mt, cloudinaryUrl, pacienteId, asesorId }) {
  // 1. Descargar si no viene pre-descargado
  let base64 = b64, mimeType = mt;
  if (!base64) {
    const dl = await descargarMediaMeta(mediaId);
    base64   = dl.base64;
    mimeType = dl.mimeType;
  }

  console.log(`📄 procesarDocumento: base64=${!!base64} mimeType=${mimeType} cloudinary=${!!cloudinaryUrl}`);

  // 2. Verificar calidad con Claude (prompt ligero)
  const calidad = await verificarCalidadDocumento(base64, mimeType);

  if (!calidad.legible) {
    return {
      legible:       false,
      problema:      calidad.problema || "La imagen no es suficientemente clara.",
      logId:         null,
      cloudinaryUrl: null,
    };
  }

  // 3. Guardar en LogIA — tipo detectado por Claude, sin extracción de campos
  const tipoMap = {
    cedula:        "CEDULA",
    carnet_eps:    "CARNET_EPS",
    orden_medica:  "ORDEN_MEDICA",
    resultado_lab: "RESULTADO_LAB",
  };
  const tipoDoc = tipoMap[calidad.tipo?.toLowerCase()] || "OTRO";

  const log = await prisma.logIA.create({
    data: {
      mediaId,
      pacienteId:      pacienteId || null,
      asesorId:        asesorId   || null,
      tipoDocumento:   tipoDoc,
      resultadoRaw:    { cloudinaryUrl: cloudinaryUrl || null, tipo: calidad.tipo },
      resultadoParsed: { legible: true, tipo: calidad.tipo },
      confianza:       1.0,
    },
  });

  return {
    legible:       true,
    problema:      null,
    logId:         log.id,
    cloudinaryUrl: cloudinaryUrl || null,
    tipoDocumento: tipoDoc,
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
