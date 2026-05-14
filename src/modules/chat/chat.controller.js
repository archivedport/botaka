// src/modules/chat/chat.controller.js
// ============================================================
//  Módulo de Gestión de Handoff BOT ↔ MANUAL
//
//  PATCH /api/chat/toggle-status   — cambiar estado de un chat
//  GET   /api/chat/status/:phone   — consultar estado actual
//  POST  /api/chat/send            — asesor envía mensaje de texto
//  POST  /api/chat/send-media      — asesor envía imagen o PDF
//  GET   /api/chat/history/:phone  — historial desde BD
// ============================================================

"use strict";

const axios  = require("axios");
const { setChatStatus, getChatStatus, getChatAsesor } = require("../../config/redis");
const { setAsesorRequest, clearAsesorRequest, getPendingAsesorRequests } = require("../../config/redis");
const { meta }      = require("../../config/env");
const auditSvc      = require("../audit/audit.service");
const { getIO }     = require("../../socket/socket");
const { guardarMensaje, obtenerHistorial, obtenerUltimosMensajes } = require("./messages.service");

// ── PATCH /api/chat/toggle-status ───────────────────────────
async function toggleStatus(req, res) {
  try {
    const { phone, action } = req.body;

    if (!phone || !["TOMAR", "LIBERAR"].includes(action)) {
      return res.status(400).json({ error: "phone y action (TOMAR|LIBERAR) son obligatorios." });
    }

    const nuevoEstado = action === "TOMAR" ? "MANUAL" : "BOT";
    const asesorId    = action === "TOMAR" ? req.usuario.id : null;

    await setChatStatus(phone, nuevoEstado, asesorId);

    if (action === "TOMAR") {
      await clearAsesorRequest(phone);

      try {
        const mensajeBienvenida = `¡Hola! 👋 Soy *${req.usuario.nombre}*, asesora de Ser Funcional. Estoy aquí para ayudarte. ¿Cuéntame, en qué te puedo colaborar?`;
        const url = `${meta.baseUrl()}/${meta.phoneId}/messages`;
        await axios.post(url,
          { messaging_product: "whatsapp", to: phone, type: "text", text: { body: mensajeBienvenida, preview_url: false } },
          { headers: { Authorization: `Bearer ${meta.token}`, "Content-Type": "application/json" } }
        );
        await guardarMensaje({ phone, de: "ASESOR", texto: mensajeBienvenida, asesorId: req.usuario.id });
        getIO().to(`chat:${phone}`).emit("chat:new_message", {
          phone, from: "ASESOR", asesorId: req.usuario.id,
          asesorNombre: req.usuario.nombre, mensaje: mensajeBienvenida, timestamp: new Date().toISOString(),
        });
        getIO().to("asesores").emit("chat:list_update", {
          phone, from: "ASESOR", mensaje: mensajeBienvenida, timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.warn("⚠️ No se pudo enviar mensaje de bienvenida:", e.message);
      }
    }

    getIO().to(`chat:${phone}`).emit("chat:status_changed", {
      phone, status: nuevoEstado, asesorId: asesorId || null,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      action === "TOMAR" ? "TOMAR_CONTROL_CHAT" : "LIBERAR_CHAT",
      entidadTipo: "Chat",
      entidadId:   phone,
      detalle:     { phone, nuevoEstado },
      req,
    });

    return res.json({
      phone, status: nuevoEstado, asesorId: asesorId || null,
      message: action === "TOMAR"
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

// ── Helpers: verificar control manual ────────────────────────
async function verificarControlManual(phone, usuarioId) {
  let status   = await getChatStatus(phone);
  let asesorId = await getChatAsesor(phone);

  if (status === "MANUAL" && !asesorId) {
    const { getBotGlobalStatus } = require("../../config/redis");
    const botGlobal = await getBotGlobalStatus();
    if (botGlobal === "OFF") {
      await setChatStatus(phone, "MANUAL", usuarioId);
      asesorId = usuarioId;
      try {
        getIO().to(`chat:${phone}`).emit("chat:status_changed", {
          phone, status: "MANUAL", asesorId: usuarioId,
        });
      } catch {}
    }
  }

  return { status, asesorId };
}

// ── POST /api/chat/send ──────────────────────────────────────
async function sendMessage(req, res) {
  try {
    const { phone, mensaje } = req.body;
    if (!phone || !mensaje?.trim()) {
      return res.status(400).json({ error: "phone y mensaje son obligatorios." });
    }

    const { status, asesorId } = await verificarControlManual(phone, req.usuario.id);

    if (status !== "MANUAL" || asesorId !== req.usuario.id) {
      return res.status(403).json({
        error: "No tienes control manual de este chat. Usa PATCH /toggle-status primero.",
      });
    }

    const url = `${meta.baseUrl()}/${meta.phoneId}/messages`;
    await axios.post(url,
      { messaging_product: "whatsapp", to: phone, type: "text", text: { body: mensaje.trim(), preview_url: false } },
      { headers: { Authorization: `Bearer ${meta.token}`, "Content-Type": "application/json" } }
    );

    await guardarMensaje({ phone, de: "ASESOR", texto: mensaje.trim(), asesorId: req.usuario.id });

    getIO().to(`chat:${phone}`).emit("chat:message_sent", {
      phone, from: "ASESOR", asesorId: req.usuario.id,
      asesorNombre: req.usuario.nombre, mensaje: mensaje.trim(), timestamp: new Date().toISOString(),
    });

    return res.json({ ok: true, message: "Mensaje enviado." });
  } catch (err) {
    console.error("Error sendMessage:", err.response?.data || err.message);
    return res.status(500).json({ error: "No se pudo enviar el mensaje a Meta." });
  }
}

// ── POST /api/chat/send-media ────────────────────────────────
//  El asesor envía una imagen o PDF al paciente.
//  Body: { phone, mediaBase64, mimeType, caption? }
async function sendMedia(req, res) {
  try {
    const { phone, mediaBase64, mimeType, caption } = req.body;

    if (!phone || !mediaBase64 || !mimeType) {
      return res.status(400).json({ error: "phone, mediaBase64 y mimeType son obligatorios." });
    }

    // Para recordatorios, tomar control automáticamente si no lo tiene.
    // Es una acción explícita del asesor — no requiere toggle previo.
    let { status, asesorId } = await verificarControlManual(phone, req.usuario.id);
    if (status !== "MANUAL" || asesorId !== req.usuario.id) {
      await setChatStatus(phone, "MANUAL", req.usuario.id);
      asesorId = req.usuario.id;
      try {
        getIO().to(`chat:${phone}`).emit("chat:status_changed", {
          phone, status: "MANUAL", asesorId: req.usuario.id,
        });
      } catch {}
    }

    // 1. Subir a Cloudinary
    const { subirImagen } = require("../../config/cloudinary");
    const cloudinaryUrl = await subirImagen(mediaBase64, mimeType);
    if (!cloudinaryUrl) throw new Error("No se pudo subir el archivo a Cloudinary.");

    // 2. Enviar por WhatsApp según tipo
    const url = `${meta.baseUrl()}/${meta.phoneId}/messages`;
    const esPDF = mimeType === "application/pdf";

    const payload = esPDF
      ? {
          messaging_product: "whatsapp",
          to:   phone,
          type: "document",
          document: {
            link:     cloudinaryUrl,
            filename: "recordatorio.pdf",
            ...(caption ? { caption } : {}),
          },
        }
      : {
          messaging_product: "whatsapp",
          to:   phone,
          type: "image",
          image: {
            link: cloudinaryUrl,
            ...(caption ? { caption } : {}),
          },
        };

    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${meta.token}`, "Content-Type": "application/json" },
    });

    // 3. Guardar en BD con mediaUrl
    const textoMensaje = caption || (esPDF ? "📄 Documento enviado" : "🖼️ Imagen enviada");
    await guardarMensaje({
      phone,
      de:       "ASESOR",
      texto:    textoMensaje,
      mediaUrl: cloudinaryUrl,
      asesorId: req.usuario.id,
    });

    // 4. Emitir por Socket.io
    const msgPayload = {
      phone,
      from:         "ASESOR",
      asesorId:     req.usuario.id,
      asesorNombre: req.usuario.nombre,
      mensaje:      textoMensaje,
      mediaUrl:     cloudinaryUrl,
      timestamp:    new Date().toISOString(),
    };
    getIO().to(`chat:${phone}`).emit("chat:new_message", msgPayload);
    getIO().to("asesores").emit("chat:list_update", msgPayload);

    // Liberar el chat de vuelta al bot después de enviar el recordatorio
    await setChatStatus(phone, "BOT", null);
    try {
      getIO().to(`chat:${phone}`).emit("chat:status_changed", {
        phone, status: "BOT", asesorId: null,
      });
    } catch {}

    console.log(`📎 Media enviado a ${phone} — ${mimeType} — ${cloudinaryUrl}`);
    return res.json({ ok: true, cloudinaryUrl });
  } catch (err) {
    console.error("Error sendMedia:", err.response?.data || err.message);
    return res.status(500).json({ error: err.message || "No se pudo enviar el archivo." });
  }
}

// ── POST /api/chat/request-asesor ───────────────────────────
async function requestAsesor(req, res) {
  try {
    const { phone, motivo } = req.body;
    if (!phone) return res.status(400).json({ error: "phone requerido." });

    await setAsesorRequest(phone, motivo || "");

    const paciente = await require("../../config/database").paciente
      .findUnique({ where: { phone }, select: { nombre: true } })
      .catch(() => null);

    try {
      getIO().to("asesores").emit("chat:asesor_solicitado", {
        phone, nombre: paciente?.nombre || null,
        motivo: motivo || null, timestamp: new Date().toISOString(),
      });
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /api/chat/pending-asesor ─────────────────────────────
async function getPendingAsesor(req, res) {
  try {
    const pendientes = await getPendingAsesorRequests();
    return res.json({ pendientes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /api/chat/bot-message ───────────────────────────────
async function saveBotMessage(req, res) {
  try {
    const { phone, texto } = req.body;
    if (!phone || !texto) return res.status(400).json({ error: "phone y texto requeridos." });
    await guardarMensaje({ phone, de: "BOT", texto });

    try {
      const payload = { phone, from: "BOT", mensaje: texto, timestamp: new Date().toISOString() };
      getIO().to(`chat:${phone}`).emit("chat:new_message", payload);
      getIO().to("asesores").emit("chat:list_update", payload);
    } catch {}

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /api/chat/last-messages ──────────────────────────────
async function getLastMessages(req, res) {
  try {
    const phones = (req.query.phones || '').split(',').filter(Boolean);
    if (!phones.length) return res.json({ mensajes: {} });
    const mapa = await obtenerUltimosMensajes(phones);
    return res.json({ mensajes: mapa });
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

module.exports = {
  toggleStatus, getStatus, sendMessage, sendMedia,
  getHistory, saveBotMessage, getLastMessages,
  requestAsesor, getPendingAsesor,
};
