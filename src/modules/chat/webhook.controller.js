// src/modules/chat/webhook.controller.js
// ============================================================
//  Webhook de Meta WhatsApp Cloud API.
//
//  GET  /webhook  — verificación de webhook (Meta handshake)
//  POST /webhook  — mensajes/eventos entrantes
//
//  Lógica de ruteo:
//    • Si status === "MANUAL" → emitir por Socket.io al panel web
//    • Si status === "BOT"    → pasar a bot.js para procesamiento
//    • Si el mensaje es un documento/imagen → pipeline de IA automático
// ============================================================

"use strict";

const axios = require("axios");
const { getChatStatus, getSession, saveMediaCache, getBotGlobalStatus } = require("../../config/redis");
const { emitirMensajePaciente } = require("../../socket/socket");
const { meta }               = require("../../config/env");
const prisma                 = require("../../config/database");
const { guardarMensaje }     = require("./messages.service");

// Se inyecta handleBot desde bot.js al registrar las rutas
let _handleBot = null;
function setHandleBot(fn) { _handleBot = fn; }

// ── GET /webhook — verificación Meta ────────────────────────
function verify(req, res) {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === meta.verifyToken) {
    console.log("✅ Webhook de Meta verificado.");
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: "Token de verificación inválido." });
}

// ── Extraer datos del payload de Meta ────────────────────────
function extraerMensaje(body) {
  try {
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // Ignorar status updates (delivered, read, etc.)
    if (value?.statuses) return null;

    const msg = value?.messages?.[0];
    if (!msg) return null;

    const from      = msg.from;
    const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString();

    let texto    = null;
    let buttonId = null;
    let mediaId  = null;
    let tipo     = msg.type;

    switch (msg.type) {
      case "text":
        texto = msg.text?.body;
        break;
      case "interactive":
        if (msg.interactive?.type === "button_reply") {
          buttonId = msg.interactive.button_reply?.id;
          texto    = msg.interactive.button_reply?.title;
        } else if (msg.interactive?.type === "list_reply") {
          buttonId = msg.interactive.list_reply?.id;
          texto    = msg.interactive.list_reply?.title;
        }
        break;
      case "image":
      case "document":
        mediaId = msg.image?.id || msg.document?.id;
        break;
      default:
        break;
    }

    return { from, texto, buttonId, mediaId, tipo, timestamp };
  } catch (err) {
    console.error("Error extrayendo mensaje:", err.message);
    return null;
  }
}

// ── POST /webhook — mensajes entrantes ───────────────────────
async function handle(req, res) {
  // Responder inmediatamente a Meta (debe ser < 5s)
  res.status(200).send("EVENT_RECEIVED");

  try {
    const msg = extraerMensaje(req.body);
    if (!msg) return;

    const { from, texto, buttonId, mediaId, tipo, timestamp } = msg;

    // Upsert del paciente en BD para asegurar que existe
    await prisma.paciente.upsert({
      where:  { phone: from },
      update: {},
      create: { phone: from },
    });

    // ── Determinar si el chat está en modo MANUAL ────────────
    // Si el bot global está OFF, poner el chat en MANUAL automáticamente
    const botGlobal = await getBotGlobalStatus();
    if (botGlobal === "OFF") {
      const { setChatStatus } = require("../../config/redis");
      const estadoActual = await getChatStatus(from);
      if (estadoActual !== "MANUAL") {
        // Poner en manual sin asesor asignado — cualquier asesor puede tomarlo
        await setChatStatus(from, "MANUAL", null);
        console.log(`🔴 Bot OFF → chat ${from} puesto en MANUAL automáticamente`);
      }
    }

    const status = botGlobal === "OFF" ? "MANUAL" : await getChatStatus(from);

    // ── Guardar y emitir mensaje del paciente SIEMPRE ───────────
    if (texto) {
      await guardarMensaje({ phone: from, de: "PACIENTE", texto });
    }
    // Emitir al panel en tiempo real sin importar el modo
    emitirMensajePaciente(from, texto || `[${tipo}]`, timestamp);

    if (status === "MANUAL") {
      // En modo MANUAL el asesor tiene el control — procesar imagen con IA
      // para que aparezca en el panel con los datos extraídos
      if (mediaId) {
        procesarDocumentoAutomatico(from, mediaId).catch(err =>
          console.error("Error auto-procesando documento:", err.message)
        );
      }
      return;
    }

    // ── Modo BOT: pasar al handler del bot ────────────────────
    try {
      const { manejarRespuestaConfirmacion } = require("../jobs/reminders");
      if (buttonId && await manejarRespuestaConfirmacion(from, buttonId)) return;
    } catch(e) { /* reminders.js aún no disponible */ }

    // Verificar si el bot está en un paso de carga de documentos
    // En ese caso, el bot manejará el media directamente
    const DOC_STEPS = ["cita_doc_cedula", "cita_doc_autorizacion", "cita_doc_historial"];
    const sesionBot = await getSession(from).catch(() => ({ paso: "inicio", datos: {} }));
    const botHandlesMedia = mediaId && DOC_STEPS.includes(sesionBot.paso);

    // Si el bot está esperando un documento:
    //  1. Descargar la imagen inmediatamente (antes de que Meta expire la URL)
    //  2. Subir a Cloudinary (URL permanente para que el asesor la vea después)
    //  3. Cachear en Redis (TTL 5min) para que el bot la use sin re-descargar
    if (botHandlesMedia) {
      try {
        const { descargarMediaMeta } = require("../documents/documents.service");
        const { subirImagen }        = require("../../config/cloudinary");

        const { base64, mimeType } = await descargarMediaMeta(mediaId);

        // Subir a Cloudinary en segundo plano — no bloquear el flujo del bot
        // La URL se guarda en Redis junto con el base64
        let cloudinaryUrl = null;
        try {
          const folder   = `documentos/${sesionBot.paso.replace("cita_doc_", "")}`;
          const publicId = `${from}_${mediaId}`;
          const result   = await subirImagen(base64, mimeType, { folder, publicId });
          cloudinaryUrl  = result.url;
          console.log(`☁️  Cloudinary OK: ${cloudinaryUrl}`);
        } catch (cloudErr) {
          console.error("⚠️ Cloudinary upload falló:", cloudErr.message);
          // Continuar — el asesor verá "sin imagen" en solicitudes
        }

        await saveMediaCache(mediaId, base64, mimeType, cloudinaryUrl);
        console.log(`📦 Media ${mediaId} cacheado para ${from}`);

        // Actualizar el mensaje del paciente con la URL de la imagen
        // para que sea visible en el chat del panel
        if (cloudinaryUrl) {
          try {
            const paciente = await prisma.paciente.findUnique({ where: { phone: from } });
            if (paciente) {
              await prisma.mensaje.create({
                data: {
                  pacienteId: paciente.id,
                  de:         "PACIENTE",
                  texto:      "[Imagen enviada]",
                  mediaUrl:   cloudinaryUrl,
                },
              });
              // Emitir al panel para que dibuje la imagen en el chat
              const { getIO: _getIO } = require("../../socket/socket");
              const imgPayload = {
                phone: from, from: "PACIENTE",
                mensaje: "[Imagen enviada]",
                mediaUrl: cloudinaryUrl,
                timestamp: new Date().toISOString(),
              };
              _getIO().to(`chat:${from}`).emit("chat:new_message", imgPayload);
              _getIO().to("asesores").emit("chat:list_update", imgPayload);
            }
          } catch(e) { console.warn("⚠️ guardar msg imagen:", e.message); }
        }
      } catch (dlErr) {
        console.error("⚠️ Error pre-descargando media:", dlErr.message);
      }
    }

    if (_handleBot) {
      // Pasar mediaId al bot — lo usa en los pasos de carga de documentos
      await _handleBot(from, texto, buttonId, mediaId);
    }

    // Solo procesar automáticamente si el asesor tiene control MANUAL del chat
    // Evita gastar tokens de IA con imágenes enviadas al azar por el paciente
    // cuando el bot está activo y no está esperando un documento
    if (mediaId && !botHandlesMedia && status === "MANUAL") {
      procesarDocumentoAutomatico(from, mediaId).catch(err =>
        console.error("Error auto-procesando documento (manual):", err.message)
      );
    }
  } catch (err) {
    console.error("Error en webhook handler:", err.message);
  }
}

// ── Helper: enviar mensaje WhatsApp de texto ────────────────
//  Versión local para el webhook (evita importar bot.js que
//  causaría dependencia circular)
async function sendWAFeedback(to, body) {
  try {
    await axios.post(
      `${meta.baseUrl()}/${meta.phoneId}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } },
      { headers: { Authorization: `Bearer ${meta.token}`, "Content-Type": "application/json" }, timeout: 8000 }
    );
  } catch (e) {
    console.error("⚠️ WA quality feedback:", e.response?.data || e.message);
  }
}

// ── Procesamiento automático de documentos ───────────────────
//
//  Flujo con control de calidad IA:
//    1. Descargar imagen de Meta
//    2. Gemini verifica si la imagen es legible (prompt ligero)
//       • No legible → avisar al paciente y detener
//       • Legible    → continuar con extracción completa
//    3. Extraer datos (reutiliza la imagen ya descargada)
//    4. Emitir evento Socket.io a los asesores
//
async function procesarDocumentoAutomatico(phone, mediaId) {
  const {
    descargarMediaMeta,
    verificarCalidadDocumento,
    procesarDocumento,
  } = require("../documents/documents.service");
  const { getIO } = require("../../socket/socket");

  const paciente = await prisma.paciente.findUnique({ where: { phone } });

  // ── PASO 1: descargar imagen ─────────────────────────────
  let base64, mimeType;
  try {
    ({ base64, mimeType } = await descargarMediaMeta(mediaId));
  } catch (err) {
    console.error("❌ Error descargando media:", err.message);
    return;
  }

  // ── PASO 2: verificar calidad con Gemini ─────────────────
  const calidad = await verificarCalidadDocumento(base64, mimeType);

  if (!calidad.legible) {
    console.log(`📷 Documento ilegible para ${phone}: ${calidad.problema}`);

    await sendWAFeedback(phone,
      `📷 *Imagen recibida*

` +
      `Tu imagen no pudo ser procesada correctamente.

` +
      `*Motivo:* _${calidad.problema || "La imagen no es suficientemente clara."}_

` +
      `Por favor envía de nuevo la foto con:
` +
      `• Buena iluminación 💡
` +
      `• Sin borrosidad ni movimiento
` +
      `• Todo el documento visible en el encuadre
` +
      `• Sobre una superficie plana y oscura

` +
      `_Cuando tengas la foto lista, solo envíala y la procesaremos automáticamente._ 📸`
    );
    return; // No procesar más — esperar que reenvíe
  }

  // ── PASO 3: subir a Cloudinary para URL permanente ──────────
  let cloudinaryUrl = null;
  try {
    const { subirImagen } = require("../../config/cloudinary");
    const result = await subirImagen(base64, mimeType, {
      folder:   "documentos/manual",
      publicId: `${phone}_${mediaId}`,
    });
    cloudinaryUrl = result.url;
    console.log(`☁️  Cloudinary manual OK: ${cloudinaryUrl}`);
  } catch (cloudErr) {
    console.error("⚠️ Cloudinary upload (manual):", cloudErr.message);
  }

  // ── PASO 4: guardar mensaje con imagen en BD y emitir al panel ──
  if (cloudinaryUrl && paciente) {
    try {
      await prisma.mensaje.create({
        data: {
          pacienteId: paciente.id,
          de:         "PACIENTE",
          texto:      "[Imagen enviada]",
          mediaUrl:   cloudinaryUrl,
        },
      });
      const { getIO: _getIO } = require("../../socket/socket");
      const imgPayload = {
        phone, from: "PACIENTE",
        mensaje: "[Imagen enviada]",
        mediaUrl: cloudinaryUrl,
        timestamp: new Date().toISOString(),
      };
      _getIO().to(`chat:${phone}`).emit("chat:new_message", imgPayload);
      _getIO().to("asesores").emit("chat:list_update", imgPayload);
    } catch(e) { console.warn("⚠️ guardar msg imagen manual:", e.message); }
  }

  // ── PASO 5: extracción completa ───────────────────────────
  let resultado;
  try {
    resultado = await procesarDocumento({
      mediaId,
      base64,
      mimeType,
      cloudinaryUrl,
      pacienteId: paciente?.id || null,
      asesorId:   null,
    });
  } catch (err) {
    console.error("❌ Error procesando documento:", err.message);
    return;
  }

  // ── PASO 6: notificar a asesores ─────────────────────────
  try {
    const io = getIO();
    io.to("asesores").emit("documento:procesado", {
      phone,
      logId:              resultado.logId,
      datos:              resultado.datos,
      confianza:          resultado.confianza,
      requiereValidacion: resultado.requiereValidacion,
      timestamp:          new Date().toISOString(),
    });
  } catch {}
}

module.exports = { verify, handle, setHandleBot };
