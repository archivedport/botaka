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

const { getChatStatus }      = require("../../config/redis");
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
    const status = await getChatStatus(from);

    // ── Guardar y emitir mensaje del paciente SIEMPRE ───────────
    if (texto) {
      await guardarMensaje({ phone: from, de: "PACIENTE", texto });
    }
    // Emitir al panel en tiempo real sin importar el modo
    emitirMensajePaciente(from, texto || `[${tipo}]`, timestamp);

    if (status === "MANUAL") {
      // Si llega una imagen/documento en modo MANUAL, procesar con IA
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

    if (_handleBot) {
      await _handleBot(from, texto, buttonId);
    }

    // Si llega un documento en modo BOT, también procesarlo
    if (mediaId && tipo === "image") {
      procesarDocumentoAutomatico(from, mediaId).catch(err =>
        console.error("Error auto-procesando documento (bot):", err.message)
      );
    }
  } catch (err) {
    console.error("Error en webhook handler:", err.message);
  }
}

// ── Procesamiento automático de documentos ───────────────────
async function procesarDocumentoAutomatico(phone, mediaId) {
  const { procesarDocumento } = require("../documents/documents.service");
  const { emitirMensajePaciente: emit, getIO } = require("../../socket/socket");

  const paciente = await prisma.paciente.findUnique({ where: { phone } });

  const resultado = await procesarDocumento({
    mediaId,
    pacienteId: paciente?.id || null,
    asesorId:   null,
  });

  // Notificar a asesores del nuevo documento procesado
  const io = getIO();
  io.to("asesores").emit("documento:procesado", {
    phone,
    logId:     resultado.logId,
    datos:     resultado.datos,
    confianza: resultado.confianza,
    requiereValidacion: resultado.requiereValidacion,
    timestamp: new Date().toISOString(),
  });
}

module.exports = { verify, handle, setHandleBot };
