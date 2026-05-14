// src/modules/calendar/calendar.service.js
// ============================================================
//  Motor de Calendario Propio (SQL + Redis Cache)
//  v2 — Soporta múltiples bloques horarios por día (mañana + tarde)
// ============================================================

"use strict";

const prisma = require("../../config/database");
const { getSlotCache, setSlotCache, invalidarSlotCache } = require("../../config/redis");
const { slotDuration, maxSlotsList } = require("../../config/env");

// ── Utilidades de tiempo ─────────────────────────────────────

function horaAMinutos(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutosAHora(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Genera slots para UN bloque horario (apertura → cierre).
 * Usa UTC+offset para Colombia (UTC-5) para que las horas
 * se guarden correctamente en la BD.
 */
function generarSlotsDeBloque(fecha, aperturaMinutos, cierreMinutos, duracion) {
  const slots = [];
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const COLOMBIA_OFFSET = 5 * 60; // UTC-5 en minutos

  for (let inicio = aperturaMinutos; inicio + duracion <= cierreMinutos; inicio += duracion) {
    // Construir en UTC compensando el offset de Colombia (UTC-5)
    const inicioUTC = inicio + COLOMBIA_OFFSET;
    const finUTC    = inicioUTC + duracion;

    const fechaInicio = new Date(Date.UTC(anio, mes - 1, dia,
      Math.floor(inicioUTC / 60), inicioUTC % 60, 0, 0));

    const fechaFin = new Date(Date.UTC(anio, mes - 1, dia,
      Math.floor(finUTC / 60), finUTC % 60, 0, 0));

    slots.push({
      inicio:    fechaInicio.toISOString(),
      fin:       fechaFin.toISOString(),
      inicioMin: inicio,
      label: `${new Date(Date.UTC(anio, mes - 1, dia)).toLocaleDateString("es-CO", {
        weekday: "long", day: "numeric", month: "short", timeZone: "America/Bogota",
      })} — ${minutosAHora(inicio)}`,
    });
  }
  return slots;
}

// ── getAvailableSlots ────────────────────────────────────────

async function getAvailableSlots(fecha, especialidad, sedeSlug) {
  // 1. Caché Redis
  const cached = await getSlotCache(sedeSlug, `${especialidad}:${fecha}`);
  if (cached) return cached;

  // 2. Sede y TODOS sus bloques horarios del día
  const sede = await prisma.sede.findUnique({
    where:   { slug: sedeSlug, activa: true },
    include: { horarios: true },
  });

  if (!sede) throw new Error(`Sede '${sedeSlug}' no encontrada o inactiva.`);

  const fechaObj  = new Date(`${fecha}T00:00:00`);
  const diaSemana = fechaObj.getDay();

  // CAMBIO v2: puede haber MÚLTIPLES bloques para el mismo día
  const bloques = sede.horarios.filter(h => h.diaSemana === diaSemana);

  if (!bloques.length) return [];

  // 3. Generar todos los slots de todos los bloques del día
  const todosLosSlots = bloques.flatMap(bloque => {
    const duracion = bloque.duracionSlot || slotDuration;
    return generarSlotsDeBloque(
      fecha,
      horaAMinutos(bloque.apertura),
      horaAMinutos(bloque.cierre),
      duracion
    );
  });

  // Ordenar por hora de inicio
  todosLosSlots.sort((a, b) => a.inicioMin - b.inicioMin);

  // 4. Citas ya ocupadas en ese día (en hora Colombia = UTC-5)
  const [a, m, d] = fecha.split("-").map(Number);
  const diaInicio = new Date(Date.UTC(a, m - 1, d, 5, 0, 0));   // 00:00 Colombia = 05:00 UTC
  const diaFin    = new Date(Date.UTC(a, m - 1, d + 1, 4, 59, 59)); // 23:59 Colombia = 04:59 UTC siguiente día

  const citasOcupadas = await prisma.cita.findMany({
    where: {
      sedeId:      sede.id,
      especialidad,
      estado:      { in: ["PENDIENTE", "CONFIRMADA"] },
      fechaInicio: { gte: diaInicio, lt: diaFin },
    },
    select: { fechaInicio: true, fechaFin: true },
  });

  // 5. Filtrar ocupados
  const slotsLibres = todosLosSlots.filter(slot => {
    const slotInicio = new Date(slot.inicio).getTime();
    const slotFin    = new Date(slot.fin).getTime();
    return !citasOcupadas.some(cita => {
      const citaInicio = new Date(cita.fechaInicio).getTime();
      const citaFin    = new Date(cita.fechaFin).getTime();
      return slotInicio < citaFin && slotFin > citaInicio;
    });
  });

  // 6. Resultado final
  const resultado = slotsLibres
    .slice(0, maxSlotsList)
    .map(({ inicio, fin, label }) => ({ inicio, fin, label, sede: sede.nombre }));

  // 7. Guardar en caché
  await setSlotCache(sedeSlug, `${especialidad}:${fecha}`, resultado);

  return resultado;
}

// ── createAppointment ────────────────────────────────────────

async function createAppointment(data) {
  const { pacienteId, sedeSlug, especialidad, fechaInicio, fechaFin, asesorId, motivoConsulta } = data;

  const inicio = new Date(fechaInicio);
  const fin    = new Date(fechaFin);

  if (isNaN(inicio) || isNaN(fin) || inicio >= fin) {
    throw new Error("Fechas de cita inválidas.");
  }
  if (inicio < new Date()) {
    throw new Error("No se pueden agendar citas en el pasado.");
  }

  const sede = await prisma.sede.findUnique({ where: { slug: sedeSlug } });
  if (!sede) throw new Error(`Sede '${sedeSlug}' no encontrada.`);

  const cita = await prisma.$transaction(async (tx) => {
    const colision = await tx.cita.findFirst({
      where: {
        sedeId:      sede.id,
        especialidad,
        estado:      { in: ["PENDIENTE", "CONFIRMADA"] },
        AND: [
          { fechaInicio: { lt: fin    } },
          { fechaFin:    { gt: inicio } },
        ],
      },
    });

    if (colision) {
      throw new Error("SLOT_OCUPADO: El horario seleccionado ya fue reservado. Por favor elige otro.");
    }

    return tx.cita.create({
      data: {
        pacienteId,
        sedeId:         sede.id,
        especialidad,
        fechaInicio:    inicio,
        fechaFin:       fin,
        estado:         "PENDIENTE",
        asesorId:       asesorId || null,
        motivoConsulta: motivoConsulta || null,
      },
      include: {
        paciente: { select: { nombre: true, phone: true, eps: true } },
        sede:     { select: { nombre: true } },
      },
    });
  }, { isolationLevel: "Serializable", timeout: 5000 });

  const fechaStr = inicio.toISOString().slice(0, 10);
  await invalidarSlotCache(sedeSlug, `${especialidad}:${fechaStr}`);

  // Vincular LogIA recientes del paciente a esta cita
  // Los documentos se procesan durante el flujo del bot, antes de crear la cita.
  // Buscamos los LogIA del paciente creados en las últimas 4 horas y los vinculamos.
  if (cita.pacienteId) {
    try {
      const ventana = new Date(Date.now() - 4 * 60 * 60 * 1000);
      await prisma.logIA.updateMany({
        where: {
          pacienteId: cita.pacienteId,
          citaId:     null,               // solo los que aún no tienen cita
          createdAt:  { gte: ventana },
        },
        data: { citaId: cita.id },
      });
    } catch (e) {
      console.warn("⚠️ No se pudieron vincular LogIA a la cita:", e.message);
    }
  }

  return cita;
}

// ── cancelAppointment ────────────────────────────────────────

async function cancelAppointment(citaId, usuarioId) {
  const cita = await prisma.cita.findUnique({ where: { id: citaId } });
  if (!cita) throw new Error("Cita no encontrada.");
  if (["CANCELADA", "COMPLETADA"].includes(cita.estado)) {
    throw new Error("La cita ya está cancelada o completada.");
  }

  const updated = await prisma.cita.update({
    where: { id: citaId },
    data:  { estado: "CANCELADA" },
  });

  const fecha = cita.fechaInicio.toISOString().slice(0, 10);
  const sede  = await prisma.sede.findUnique({ where: { id: cita.sedeId } });
  if (sede) await invalidarSlotCache(sede.slug, `${cita.especialidad}:${fecha}`);

  return updated;
}

// ── getAppointmentsByPaciente ────────────────────────────────

async function getAppointmentsByPaciente(pacienteId, { page = 1, limit = 20 } = {}) {
  const [total, citas] = await Promise.all([
    prisma.cita.count({ where: { pacienteId } }),
    prisma.cita.findMany({
      where:   { pacienteId },
      orderBy: { fechaInicio: "desc" },
      skip:    (page - 1) * limit,
      take:    limit,
      include: { sede: { select: { nombre: true } } },
    }),
  ]);
  return { total, page, limit, citas };
}

module.exports = {
  getAvailableSlots,
  createAppointment,
  cancelAppointment,
  getAppointmentsByPaciente,
};
