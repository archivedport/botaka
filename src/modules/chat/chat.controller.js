// src/modules/chat/chat.controller.js
// ============================================================
//  Módulo de Gestión de Handoff BOT ↔ MANUAL
//
//  PATCH /api/chat/toggle-status   — cambiar estado de un chat
//  GET   /api/chat/status/:phone   — consultar estado actual
//  POST  /api/chat/send            — asesor envía mensaje vía Meta API
//  GET   /api/chat/history/:phone  — historial básico desde Redis
// ============================================================

"use strict";

const axios  = require("axios");
const { setChatStatus, getChatStatus, getChatAsesor } = require("../../config/redis");
const { meta }      = require("../../config/env");
const auditSvc      = require("../audit/audit.service");
const { getIO }     = require("../../socket/socket");
const { guardarMensaje, obtenerHistorial } = require("./messages.service");

// ── PATCH /api/chat/toggle-status ───────────────────────────
//  Body: { phone, action: "TOMAR" | "LIBERAR" }
async function toggleStatus(req, res) {
  try {
    const { phone, action } = req.body;

    if (!phone || !["TOMAR", "LIBERAR"].includes(action)) {
      return res.status(400).json({ error: "phone y action (TOMAR|LIBERAR) son obligatorios." });
    }

    const nuevoEstado = action === "TOMAR" ? "MANUAL" : "BOT";
    const asesorId    = action === "TOMAR" ? req.usuario.id : null;

    await setChatStatus(phone, nuevoEstado, asesorId);

    // Notificar a la sala WebSocket del asesor
    const io = getIO();
    io.to(`chat:${phone}`).emit("chat:status_changed", {
      phone,
      status:   nuevoEstado,
      asesorId: asesorId || null,
    });

    // Auditoría
    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      action === "TOMAR" ? "TOMAR_CONTROL_CHAT" : "LIBERAR_CHAT",
      entidadTipo: "Chat",
      entidadId:   phone,
      detalle:     { phone, nuevoEstado },
      req,
    });

    return res.json({
      phone,
      status:   nuevoEstado,
      asesorId: asesorId || null,
      message:  action === "TOMAR"
        ? `Chat con ${phone} tomado. El bot está silenciado.`
        : `Chat con ${phone} liberado. El bot retoma el control.`,
    });
  } catch (err) {
    console.error("Error toggleStatus:", err);
    return res.status(500).json({ error: "Error interno." });
  }
}

// ── GET /api/chat/status/:phone ──────────────────────────────
async function getStatus(req, res) {
  try {
    const { phone } = req.params;
    const status    = await getChatStatus(phone);
    const asesorId  = await getChatAsesor(phone);
    return res.json({ phone, status, asesorId });
  } catch (err) {
    return res.status(500).json({ error: "Error interno." });
  }
}

// ── POST /api/chat/send ──────────────────────────────────────
//  El asesor envía un mensaje de texto al paciente desde la web.
//  Body: { phone, mensaje }
async function sendMessage(req, res) {
  try {
    const { phone, mensaje } = req.body;

    if (!phone || !mensaje?.trim()) {
      return res.status(400).json({ error: "phone y mensaje son obligatorios." });
    }

    // Solo permitir si el asesor tiene control MANUAL de ese chat
    const status   = await getChatStatus(phone);
    const asesorId = await getChatAsesor(phone);

    if (status !== "MANUAL" || asesorId !== req.usuario.id) {
      return res.status(403).json({
        error: "No tienes control manual de este chat. Usa PATCH /toggle-status primero.",
      });
    }

    // Enviar via Meta Cloud API
    const url = `${meta.baseUrl()}/${meta.phoneId}/messages`;
    await axios.post(url,
      {
        messaging_product: "whatsapp",
        to:   phone,
        type: "text",
        text: { body: mensaje.trim(), preview_url: false },
      },
      { headers: { Authorization: `Bearer ${meta.token}`, "Content-Type": "application/json" } }
    );

    // Guardar mensaje del asesor en BD
    await guardarMensaje({ phone, de: "ASESOR", texto: mensaje.trim(), asesorId: req.usuario.id });

    // Emitir al WebSocket para que el panel muestre el mensaje enviado
    const io = getIO();
    io.to(`chat:${phone}`).emit("chat:message_sent", {
      phone,
      from:      "ASESOR",
      asesorId:  req.usuario.id,
      asesorNombre: req.usuario.nombre,
      mensaje:   mensaje.trim(),
      timestamp: new Date().toISOString(),
    });

    return res.json({ ok: true, message: "Mensaje enviado." });
  } catch (err) {
    console.error("Error sendMessage:", err.response?.data || err.message);
    return res.status(500).json({ error: "No se pudo enviar el mensaje a Meta." });
  }
}

// ── POST /api/chat/bot-message (interno, llamado desde bot.js) ─
async function saveBotMessage(req, res) {
  try {
    const { phone, texto } = req.body;
    if (!phone || !texto) return res.status(400).json({ error: "phone y texto requeridos." });
    await guardarMensaje({ phone, de: "BOT", texto });

    // Emitir al panel en tiempo real
    try {
      const { getIO } = require("../../socket/socket");
      const payload = {
        phone,
        from:      "BOT",
        mensaje:   texto,
        timestamp: new Date().toISOString(),
      };
      getIO().to(`chat:${phone}`).emit("chat:new_message", payload);
      getIO().to("asesores").emit("chat:new_message", payload);
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /api/chat/history/:phone ─────────────────────────────
async function getHistory(req, res) {
  try {
    const { phone } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const result = await obtenerHistorial(phone, {
      page:  parseInt(page),
      limit: parseInt(limit),
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { toggleStatus, getStatus, sendMessage, getHistory, saveBotMessage };
