// src/modules/solicitudes/solicitudes.service.js
// ============================================================
//  Lógica de negocio para aprobación/denegación de solicitudes
//  de citas médicas.
//
//  Responsabilidades:
//    1. Consultar citas PENDIENTE con paciente + sede + docs IA
//    2. Aprobar → CONFIRMADA + notificar WhatsApp + emitir socket
//    3. Denegar → CANCELADA  + notificar WhatsApp + emitir socket
//    4. Invalidar caché de slots al denegar (libera el slot)
// ============================================================

"use strict";

const axios  = require("axios");
const prisma = require("../../config/database");
const { meta }               = require("../../config/env");
const { getIO }              = require("../../socket/socket");
const { invalidarSlotCache } = require("../../config/redis");
const { guardarMensaje }     = require("../chat/messages.service");

// ── Helpers de envío WhatsApp ────────────────────────────────
// Mismo patrón que chat.controller.js: axios directo con meta.*

const waUrl     = () => `${meta.baseUrl()}/${meta.phoneId}/messages`;
const waHeaders = () => ({
  Authorization:  `Bearer ${meta.token}`,
  "Content-Type": "application/json",
});

async function sendWhatsApp(to, body) {
  try {
    await axios.post(
      waUrl(),
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body, preview_url: false },
      },
      { headers: waHeaders(), timeout: 8000 }
    );
  } catch (err) {
    // No romper el flujo si falla el envío — el asesor ya tomó la acción
    console.error("⚠️  WA notify solicitud:", err.response?.data || err.message);
  }
}

// ── Formatear fecha en zona horaria Colombia ─────────────────

function fmtFechaColombia(date) {
  return new Date(date).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    weekday:  "long",
    day:      "numeric",
    month:    "long",
    hour:     "2-digit",
    minute:   "2-digit",
  });
}

// ══════════════════════════════════════════════════════════════
// GET — Lista solicitudes pendientes
// ══════════════════════════════════════════════════════════════

/**
 * Devuelve todas las citas PENDIENTE con paciente, sede y
 * documentos IA del paciente (logsIA) incluidos.
 *
 * @param {object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=50]
 * @returns {{ total, page, limit, solicitudes }}
 */
async function getSolicitudes({ page = 1, limit = 50 } = {}) {
  const where = { estado: "PENDIENTE" };

  const [total, citas] = await Promise.all([
    prisma.cita.count({ where }),
    prisma.cita.findMany({
      where,
      orderBy: { createdAt: "asc" },    // más antigua primero = más urgente
      skip:    (page - 1) * limit,
      take:    limit,
      include: {
        paciente: {
          select: {
            id:          true,
            nombre:      true,
            phone:       true,
            documento:   true,
            eps:         true,
            vigenciaEPS: true,
            celular:     true,
            email:       true,
            // Documentos IA vinculados al paciente
            logsIA: {
              orderBy: { createdAt: "desc" },
              take:    5,    // máx 5 docs más recientes
              select: {
                id:              true,
                tipoDocumento:   true,
                resultadoParsed: true,
                confianza:       true,
                createdAt:       true,
                validadoEn:      true,
              },
            },
          },
        },
        sede:   { select: { id: true, nombre: true, slug: true, direccion: true } },
        asesor: { select: { nombre: true } },
      },
    }),
  ]);

  // Aplanar: subir logsIA al nivel raíz como `documentos`
  const solicitudes = citas.map(c => ({
    ...c,
    documentos: c.paciente?.logsIA || [],
  }));

  return { total, page, limit, solicitudes };
}

// ══════════════════════════════════════════════════════════════
// PATCH — Aprobar solicitud
// ══════════════════════════════════════════════════════════════

/**
 * Aprueba una cita PENDIENTE:
 *   1. Cambia estado → CONFIRMADA en BD
 *   2. Emite `calendar:cita_actualizada` por Socket.io
 *   3. Envía mensaje de confirmación por WhatsApp al paciente
 *
 * @param {string} citaId
 * @param {object} opts
 * @param {string} opts.asesorId
 * @param {string} [opts.nota]  — mensaje opcional para el paciente
 * @returns {Cita}
 */
async function aprobarSolicitud(citaId, { asesorId, nota = "" }) {
  // 1. Verificar que existe y está PENDIENTE
  const citaExistente = await prisma.cita.findUnique({
    where:   { id: citaId },
    include: {
      paciente: { select: { phone: true, nombre: true } },
      sede:     { select: { nombre: true, direccion: true } },
    },
  });

  if (!citaExistente) {
    throw new Error("Solicitud no encontrada.");
  }
  if (citaExistente.estado !== "PENDIENTE") {
    throw new Error(`La solicitud ya fue procesada (estado: ${citaExistente.estado}).`);
  }

  // 2. Actualizar BD
  const cita = await prisma.cita.update({
    where: { id: citaId },
    data:  {
      estado:   "CONFIRMADA",
      asesorId: asesorId || null,
      notas:    nota || null,
    },
    include: {
      paciente: { select: { id: true, nombre: true, phone: true } },
      sede:     { select: { id: true, nombre: true, slug: true } },
    },
  });

  // 3. Emitir Socket.io → actualiza calendario en tiempo real en todos los paneles
  try {
    getIO().to("asesores").emit("calendar:cita_actualizada", { cita });
  } catch (e) {
    console.warn("Socket emit error (aprobar):", e.message);
  }

  // 4. Notificar al paciente por WhatsApp
  const phone       = citaExistente.paciente.phone;
  const nombrePac   = citaExistente.paciente.nombre || "Paciente";
  const fechaLabel  = fmtFechaColombia(cita.fechaInicio);
  const sedeNombre  = cita.sede?.nombre  || citaExistente.sede?.nombre  || "nuestra sede";
  const sedeDirec   = citaExistente.sede?.direccion || "";

  let mensaje = `✅ *Cita confirmada*\n\n`
    + `Hola ${nombrePac}, tu cita de *${cita.especialidad}* ha sido *aprobada*.\n\n`
    + `📅 ${fechaLabel}\n`
    + `📍 ${sedeNombre}${sedeDirec ? ` — ${sedeDirec}` : ""}\n\n`;

  if (nota) {
    mensaje += `📝 Nota del asesor: _${nota}_\n\n`;
  }

  mensaje += `Por favor llega 10 minutos antes de tu cita. ¡Nos vemos pronto! 😊`;

  await sendWhatsApp(phone, mensaje);

  // Persistir en BD para que aparezca en el historial del panel
  await guardarMensaje({ phone, de: "BOT", texto: mensaje });

  // Emitir al panel en tiempo real — dibuja la burbuja en chats.html
  try {
    const io = getIO();
    const payload = { phone, from: "BOT", mensaje, timestamp: new Date().toISOString() };
    io.to(`chat:${phone}`).emit("chat:new_message", payload);
    io.to("asesores").emit("chat:list_update", payload);
  } catch {}

  return cita;
}

// ══════════════════════════════════════════════════════════════
// PATCH — Denegar solicitud
// ══════════════════════════════════════════════════════════════

/**
 * Deniega una cita PENDIENTE:
 *   1. Cambia estado → CANCELADA en BD
 *   2. Invalida caché de slots en Redis (libera el horario)
 *   3. Emite `calendar:cita_actualizada` por Socket.io
 *   4. Envía mensaje de denegación por WhatsApp al paciente
 *
 * @param {string} citaId
 * @param {object} opts
 * @param {string} opts.asesorId
 * @param {string} [opts.nota]  — motivo opcional para el paciente
 * @returns {Cita}
 */
async function denegarSolicitud(citaId, { asesorId, nota = "" }) {
  // 1. Verificar que existe y está PENDIENTE
  const citaExistente = await prisma.cita.findUnique({
    where:   { id: citaId },
    include: {
      paciente: { select: { phone: true, nombre: true } },
      sede:     { select: { nombre: true, slug: true } },
    },
  });

  if (!citaExistente) {
    throw new Error("Solicitud no encontrada.");
  }
  if (citaExistente.estado !== "PENDIENTE") {
    throw new Error(`La solicitud ya fue procesada (estado: ${citaExistente.estado}).`);
  }

  // 2. Actualizar BD
  const cita = await prisma.cita.update({
    where: { id: citaId },
    data:  {
      estado:   "CANCELADA",
      asesorId: asesorId || null,
      notas:    nota || null,
    },
    include: {
      paciente: { select: { id: true, nombre: true, phone: true } },
      sede:     { select: { id: true, nombre: true, slug: true } },
    },
  });

  // 3. Invalidar caché de slots → el horario queda disponible de nuevo
  try {
    const sedeSlug = cita.sede?.slug || citaExistente.sede?.slug;
    if (sedeSlug) {
      const fechaStr = citaExistente.fechaInicio.toISOString().slice(0, 10);
      await invalidarSlotCache(sedeSlug, `${citaExistente.especialidad}:${fechaStr}`);
    }
  } catch (e) {
    console.warn("Redis invalidar slot (denegar):", e.message);
  }

  // 4. Emitir Socket.io
  try {
    getIO().to("asesores").emit("calendar:cita_actualizada", { cita });
  } catch (e) {
    console.warn("Socket emit error (denegar):", e.message);
  }

  // 5. Notificar al paciente por WhatsApp
  const phone     = citaExistente.paciente.phone;
  const nombrePac = citaExistente.paciente.nombre || "Paciente";

  let mensaje = `❌ *Cita no aprobada*\n\n`
    + `Hola ${nombrePac}, lamentablemente tu solicitud de cita de `
    + `*${citaExistente.especialidad}* no pudo ser aprobada en este momento.\n\n`;

  if (nota) {
    mensaje += `📝 Motivo: _${nota}_\n\n`;
  }

  mensaje += `Si deseas reagendar o tienes preguntas, escribe *Hola* para volver al menú `
    + `o solicita hablar con un asesor. 🙏`;

  await sendWhatsApp(phone, mensaje);

  // Persistir en BD + emitir al panel
  await guardarMensaje({ phone, de: "BOT", texto: mensaje });

  try {
    const io = getIO();
    const payload = { phone, from: "BOT", mensaje, timestamp: new Date().toISOString() };
    io.to(`chat:${phone}`).emit("chat:new_message", payload);
    io.to("asesores").emit("chat:list_update", payload);
  } catch {}

  return cita;
}

module.exports = { getSolicitudes, aprobarSolicitud, denegarSolicitud };
