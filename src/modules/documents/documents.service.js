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

const EXTRACTION_PROMPT = `Analiza esta imagen de un documento médico colombiano para la IPS "Ser Funcional" (rehabilitación funcional).

Extrae los datos y responde ÚNICAMENTE con un JSON válido sin bloques de código:
{
  "tipoDocumento": "CEDULA | ORDEN_MEDICA | HISTORIA_CLINICA | CARNET_EPS | OTRO",
  "nombre": "Nombre completo del paciente o null",
  "cedula": "Número de documento de identidad o null",
  "eps": "Nombre de la EPS o null",
  "fechaOrden": "Fecha de la orden médica en YYYY-MM-DD o null",
  "diagnostico": "Diagnóstico o motivo de consulta o null",
  "firmaMedico": "Nombre del médico que firma o null",
  "tipoMedico": "general | especialista | null",
  "servicioOrdenado": "Tipo de terapia ordenada (física, ocupacional, fonoaudiología, respiratoria) o null",
  "observaciones": "Cualquier dato relevante adicional, alertas sobre vigencia o tipo de accidente o null",
  "confianza": 0.0
}
Si no puedes leer un campo, usa null. El campo confianza va de 0.0 a 1.0.
No incluyas texto fuera del JSON.`;

// ── Prompt de control de calidad ─────────────────────────────
// Gemini evalúa si la imagen es procesable ANTES de hacer la
// extracción completa. Evita pasar imágenes borrosas o inválidas
// al pipeline de IA y ahorra tokens y tiempo.

// ── Reglas base de legibilidad (comunes a todos los pasos) ──────
const REGLAS_BASE = `
REGLAS DE LEGIBILIDAD — considera NO legible si:
- Está borrosa, desenfocada o movida
- Muy oscura, sobreexpuesta o con reflejo
- El documento está cortado (faltan bordes importantes)
- Ángulo mayor a 30° (muy inclinada)
- Resolución insuficiente para leer texto
- No es ningún documento (foto de persona, paisaje, pantalla de celular, etc.)`;

// ── Reglas de cédula colombiana ──────────────────────────────
const REGLAS_CEDULA = `
TIPOS DE CÉDULA COLOMBIANA:
  A) Cédula MODERNA (azul/blanca, laminada, con chip o sin chip reciente): subtipo "cedula_moderna"
  B) Cédula ANTIGUA (amarilla/dorada, plastificada):
     - Frente: apellidos, nombres, número, firma → subtipo "cedula_antigua_frente"
     - Reverso: huella dactilar, fecha/lugar nacimiento, fecha/lugar expedición → subtipo "cedula_antigua_reverso"
- Si es documento de otro país → legible: false, problema: "Solo aceptamos cédula de ciudadanía colombiana."
- Si no dice "República de Colombia" → legible: false, problema: "Solo aceptamos cédula de ciudadanía colombiana."`;

/**
 * Genera el prompt de calidad según el paso del bot.
 * Esto le dice a Claude exactamente qué documento se espera
 * y qué debe rechazar en cada momento del flujo.
 */
function getQualityPrompt(paso) {
  const base = `Analiza esta imagen para la IPS "Ser Funcional" (rehabilitación funcional).
Responde ÚNICAMENTE con JSON válido, sin bloques de código:
{
  "legible": true o false,
  "tipo": "cedula | orden_medica | historia_clinica | carnet_eps | foto_personal | no_documento | otro",
  "subtipo": null,
  "problema": "descripción breve en español o null si está OK",
  "alertas": []
}
${REGLAS_BASE}`;

  switch (paso) {
    case "cita_doc_cedula":
      return base + `

SE ESPERA: Cédula de ciudadanía (CC) o Tarjeta de Identidad (TI) COLOMBIANA — frente.
${REGLAS_CEDULA}
Si la imagen es cualquier otra cosa (orden médica, autorización EPS, historial, carnet, foto personal) →
  legible: false, problema: "Se esperaba la cédula o tarjeta de identidad. Por favor envía el documento de identidad colombiano."`;

    case "cita_doc_cedula_reverso":
      return base + `

SE ESPERA: Reverso de cédula ANTIGUA colombiana (huella dactilar, fecha nacimiento, lugar expedición).
${REGLAS_CEDULA}
- Si detectas el FRENTE de la cédula (nombre, apellidos, firma) → legible: false, problema: "Eso es el frente de la cédula. Por favor envía el REVERSO — la parte con la huella dactilar."
- Si es cualquier otro documento (orden médica, autorización, historial) → legible: false, problema: "Se esperaba el reverso de la cédula. Por favor envía la parte trasera con la huella dactilar."`;

    case "cita_doc_autorizacion":
      return base + `

SE ESPERA: Autorización o remisión emitida por la EPS para la atención en la IPS.
Puede ser: papel con membrete de la EPS, código de autorización, orden de servicio, remisión.
- Si es una cédula → legible: false, problema: "Eso es una cédula, no la autorización. Por favor envía el documento de autorización que te dio tu EPS."
- Si es una orden médica (firmada por médico, con diagnóstico) → legible: false, problema: "Eso parece una orden médica, no la autorización EPS. Por favor envía la autorización que te entregó tu EPS."
- Si es historial clínico → legible: false, problema: "Eso es una historia clínica, no la autorización. Por favor envía la autorización de tu EPS."
- Si es foto personal o no es documento → legible: false, problema: "No es un documento válido. Por favor envía la autorización de tu EPS."`;

    case "cita_doc_historial":
      return base + `

SE ESPERA: Historia clínica, evolución médica o cualquier documento clínico del paciente.
- Si es una cédula → legible: false, problema: "Eso es una cédula, no una historia clínica. Por favor envía tu historia clínica o escribe 'omitir' si no la tienes."
- Si es una autorización EPS → legible: false, problema: "Eso es una autorización EPS, no la historia clínica. Por favor envía tu historia clínica o escribe 'omitir'."
- Si es foto personal o no es documento → legible: false, problema: "No es un documento clínico válido. Por favor envía tu historia clínica o escribe 'omitir'."
- Ser más permisivo aquí: cualquier documento médico (receta, examen, evolución) es aceptable.`;

    default:
      // Prompt genérico para uso automático (modo MANUAL, etc.)
      return base + `

Verifica que sea un documento colombiano válido (cédula, orden médica, autorización EPS, historia clínica).
REGLAS para órdenes médicas:
- Si menciona "accidente de tránsito", "SOAT", "ARL" o "accidente laboral" → legible: false, problema: "No atendemos accidentes de tránsito (SOAT) ni accidentes laborales (ARL). Solo enfermedad general."
- Si parece vencida (fecha mayor a 30 días) → alertas: ["La orden puede estar vencida. El asesor verificará."]
- Si no tiene firma médica visible → alertas: ["No se detecta firma médica. El asesor verificará."]`;
  }
}

// Alias para compatibilidad con código que use QUALITY_PROMPT directamente
const QUALITY_PROMPT = getQualityPrompt("default");

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
async function verificarCalidadDocumento(base64, mimeType, paso = "default") {
  try {
    const promptParaPaso = getQualityPrompt(paso);
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
            { type: "text", text: promptParaPaso },
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
async function procesarDocumento({ mediaId, base64: b64, mimeType: mt, cloudinaryUrl, pacienteId, asesorId, paso }) {
  // 1. Descargar si no viene pre-descargado
  let base64 = b64, mimeType = mt;
  if (!base64) {
    const dl = await descargarMediaMeta(mediaId);
    base64   = dl.base64;
    mimeType = dl.mimeType;
  }

  console.log(`📄 procesarDocumento: base64=${!!base64} mimeType=${mimeType} cloudinary=${!!cloudinaryUrl}`);

  // 2. Verificar calidad con Claude (prompt ligero)
  const calidad = await verificarCalidadDocumento(base64, mimeType, paso || "default");

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
    subtipo:       calidad.subtipo || null,  // cedula_antigua_frente | cedula_moderna | etc.
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
