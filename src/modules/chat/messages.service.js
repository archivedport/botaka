// src/modules/chat/messages.service.js
// ============================================================
//  Servicio de persistencia de mensajes de chat.
//  Guarda todos los mensajes (PACIENTE, BOT, ASESOR) en BD.
// ============================================================

"use strict";

const prisma = require("../../config/database");

/**
 * Guarda un mensaje en la BD.
 * @param {object} opts
 * @param {string} opts.phone      — número del paciente
 * @param {string} opts.de         — 'PACIENTE' | 'BOT' | 'ASESOR'
 * @param {string} opts.texto      — contenido del mensaje
 * @param {string} [opts.asesorId] — solo si de === 'ASESOR'
 */
async function guardarMensaje({ phone, de, texto, asesorId = null }) {
  try {
    if (!texto?.trim()) return null;

    const paciente = await prisma.paciente.findUnique({ where: { phone } });
    if (!paciente) return null;

    return await prisma.mensaje.create({
      data: {
        pacienteId: paciente.id,
        de,
        texto:    texto.trim(),
        asesorId: asesorId || null,
      },
    });
  } catch (err) {
    // Nunca romper el flujo principal por un error de persistencia
    console.error("⚠️ Error guardando mensaje:", err.message);
    return null;
  }
}

/**
 * Obtiene el historial de mensajes de un paciente por phone.
 * @param {string} phone
 * @param {object} opts
 * @param {number} opts.page
 * @param {number} opts.limit
 */
async function obtenerHistorial(phone, { page = 1, limit = 50 } = {}) {
  const paciente = await prisma.paciente.findUnique({ where: { phone } });
  if (!paciente) return { total: 0, mensajes: [] };

  const [total, mensajes] = await Promise.all([
    prisma.mensaje.count({ where: { pacienteId: paciente.id } }),
    prisma.mensaje.findMany({
      where:   { pacienteId: paciente.id },
      orderBy: { createdAt: "asc" },
      skip:    (page - 1) * limit,
      take:    limit,
      include: { paciente: { select: { nombre: true } } },
    }),
  ]);

  return { total, page, limit, mensajes };
}

module.exports = { guardarMensaje, obtenerHistorial };
