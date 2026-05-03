// src/jobs/reminders.js
// ============================================================
//  Cron job de recordatorios automáticos.
//  Corre cada 30 minutos. Envía mensajes de WhatsApp a pacientes:
//    • 24h antes de la cita → confirmación activa (Sí/No)
//    •  2h antes de la cita → recordatorio final
// ============================================================

"use strict";

const axios  = require("axios");
const prisma = require("../config/database");
const { meta } = require("../config/env");

const WA_URL = `${meta.baseUrl()}/${meta.phoneId}/messages`;
const WA_HEADERS = {
  Authorization:  `Bearer ${meta.token}`,
  "Content-Type": "application/json",
};

// ── Utilidades ───────────────────────────────────────────────

function fmtFecha(fecha) {
  return new Date(fecha).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    weekday:  "long",
    day:      "numeric",
    month:    "long",
    hour:     "2-digit",
    minute:   "2-digit",
  });
}

async function enviarMensaje(phone, payload) {
  try {
    await axios.post(WA_URL, { messaging_product: "whatsapp", to: phone, ...payload }, { headers: WA_HEADERS });
    return true;
  } catch (e) {
    console.error(`❌ Recordatorio fallido → ${phone}:`, e.response?.data?.error?.message || e.message);
    return false;
  }
}

// ── Recordatorio 24h — confirmación activa ───────────────────

async function enviarRecordatorio24h() {
  const ahora    = new Date();
  const en24h    = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
  const ventana  = new Date(ahora.getTime() + 25 * 60 * 60 * 1000); // +1h de margen

  const citas = await prisma.cita.findMany({
    where: {
      estado:          { in: ["PENDIENTE", "CONFIRMADA"] },
      recordatorio24h: false,
      fechaInicio: { gte: en24h, lte: ventana },
    },
    include: {
      paciente: { select: { phone: true, nombre: true } },
      sede:     { select: { nombre: true } },
    },
  });

  if (!citas.length) return;
  console.log(`🔔 Recordatorios 24h: ${citas.length} citas`);

  for (const cita of citas) {
    const { phone, nombre } = cita.paciente;
    if (!phone) continue;

    const nombreCorto = nombre ? nombre.split(" ")[0] : "Paciente";

    const enviado = await enviarMensaje(phone, {
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "⏰ Recordatorio de cita" },
        body: {
          text:
            `Hola *${nombreCorto}*, te recordamos tu cita mañana:\n\n` +
            `🩺 *${cita.especialidad}*\n` +
            `📅 ${fmtFecha(cita.fechaInicio)}\n` +
            `📍 ${cita.sede.nombre}\n\n` +
            `¿Confirmas tu asistencia?`,
        },
        footer: { text: "Ser Funcional I.P.S" },
        action: {
          buttons: [
            { type: "reply", reply: { id: `confirmar_si_${cita.id}`, title: "✅ Sí, asistiré"    } },
            { type: "reply", reply: { id: `confirmar_no_${cita.id}`, title: "❌ No podré asistir" } },
          ],
        },
      },
    });

    if (enviado) {
      await prisma.cita.update({
        where: { id: cita.id },
        data:  { recordatorio24h: true },
      });
    }
  }
}

// ── Recordatorio 2h — aviso final ────────────────────────────

async function enviarRecordatorio2h() {
  const ahora   = new Date();
  const en2h    = new Date(ahora.getTime() + 2 * 60 * 60 * 1000);
  const ventana = new Date(ahora.getTime() + 2.5 * 60 * 60 * 1000);

  const citas = await prisma.cita.findMany({
    where: {
      estado:         { in: ["PENDIENTE", "CONFIRMADA"] },
      recordatorio2h: false,
      fechaInicio: { gte: en2h, lte: ventana },
    },
    include: {
      paciente: { select: { phone: true, nombre: true } },
      sede:     { select: { nombre: true, direccion: true } },
    },
  });

  if (!citas.length) return;
  console.log(`🔔 Recordatorios 2h: ${citas.length} citas`);

  for (const cita of citas) {
    const { phone, nombre } = cita.paciente;
    if (!phone) continue;

    const nombreCorto = nombre ? nombre.split(" ")[0] : "Paciente";

    const enviado = await enviarMensaje(phone, {
      type: "text",
      text: {
        body:
          `⏰ *Recordatorio — en 2 horas*\n\n` +
          `Hola *${nombreCorto}*! Tu cita es muy pronto:\n\n` +
          `🩺 *${cita.especialidad}*\n` +
          `📅 ${fmtFecha(cita.fechaInicio)}\n` +
          `📍 ${cita.sede.nombre}\n` +
          `📌 ${cita.sede.direccion}\n\n` +
          `_Por favor llega 10 minutos antes._`,
        preview_url: false,
      },
    });

    if (enviado) {
      await prisma.cita.update({
        where: { id: cita.id },
        data:  { recordatorio2h: true },
      });
    }
  }
}

// ── Manejar respuestas de confirmación del paciente ──────────
//  Llama a esto desde webhook.controller cuando llega
//  buttonId === "confirmar_asistencia_si" o "confirmar_asistencia_no"

async function manejarRespuestaConfirmacion(phone, buttonId) {
  // Formato nuevo: "confirmar_si_{citaId}" o "confirmar_no_{citaId}"
  // Formato viejo (compatibilidad): "confirmar_asistencia_si" / "confirmar_asistencia_no"
  let esConfirmacion = false;
  let esCancelacion  = false;
  let citaId         = null;

  if (buttonId.startsWith("confirmar_si_")) {
    esConfirmacion = true;
    citaId = buttonId.replace("confirmar_si_", "");
  } else if (buttonId.startsWith("confirmar_no_")) {
    esCancelacion = true;
    citaId = buttonId.replace("confirmar_no_", "");
  } else if (buttonId === "confirmar_asistencia_si") {
    esConfirmacion = true;
  } else if (buttonId === "confirmar_asistencia_no") {
    esCancelacion = true;
  } else {
    return false;
  }

  let cita;

  if (citaId) {
    // Formato nuevo: buscar por ID exacto — no hay ambigüedad
    cita = await prisma.cita.findUnique({
      where:   { id: citaId },
      include: { sede: { select: { nombre: true } } },
    });
    // Verificar que pertenece al paciente que respondió
    const paciente = await prisma.paciente.findUnique({ where: { phone } });
    if (!cita || cita.pacienteId !== paciente?.id) return false;
  } else {
    // Formato viejo (fallback): buscar la cita más próxima
    const paciente = await prisma.paciente.findUnique({ where: { phone } });
    if (!paciente) return false;
    const ahora = new Date();
    const en36h = new Date(ahora.getTime() + 36 * 60 * 60 * 1000);
    cita = await prisma.cita.findFirst({
      where: {
        pacienteId:  paciente.id,
        estado:      { in: ["PENDIENTE", "CONFIRMADA"] },
        fechaInicio: { gte: ahora, lte: en36h },
      },
      include: { sede: { select: { nombre: true } } },
      orderBy: { fechaInicio: "asc" },
    });
  }

  if (!cita) return false;

  if (esConfirmacion) {
    await prisma.cita.update({ where: { id: cita.id }, data: { estado: "CONFIRMADA" } });
    await enviarMensaje(phone, {
      type: "text",
      text: {
        body:
          `✅ *¡Confirmado!* Gracias por confirmar tu asistencia.\n\n` +
          `Te esperamos:\n📅 ${fmtFecha(cita.fechaInicio)}\n📍 ${cita.sede.nombre}\n\n` +
          `_Recuerda traer tu documento de identidad y autorización de EPS._`,
        preview_url: false,
      },
    });
  } else {
    await prisma.cita.update({ where: { id: cita.id }, data: { estado: "CANCELADA" } });
    await enviarMensaje(phone, {
      type: "text",
      text: {
        body:
          `Entendemos, hemos cancelado tu cita. 😔\n\n` +
          `Cuando quieras reagendarla, escríbenos *"Hola"* y te ayudamos. 🙂`,
        preview_url: false,
      },
    });
  }

  return true;
}

// ── Loop principal ────────────────────────────────────────────

let _intervalo = null;

function iniciarRecordatorios() {
  console.log("⏰ Iniciando job de recordatorios (cada 30 min)...");

  async function tick() {
    try {
      await enviarRecordatorio24h();
      await enviarRecordatorio2h();
    } catch (err) {
      console.error("❌ Error en job de recordatorios:", err.message);
    }
  }

  // Primer tick inmediato
  tick();

  // Luego cada 30 minutos
  _intervalo = setInterval(tick, 30 * 60 * 1000);
}

function detenerRecordatorios() {
  if (_intervalo) { clearInterval(_intervalo); _intervalo = null; }
}

module.exports = { iniciarRecordatorios, detenerRecordatorios, manejarRespuestaConfirmacion };
