// src/modules/calendar/calendar.service.js
// ============================================================
//  Motor de Calendario Propio (SQL + Redis Cache)
//
//  getAvailableSlots(fecha, especialidad, sedeSlug)
//    → Calcula huecos libres a partir de horarios y citas existentes
//
//  createAppointment(data)
//    → Crea la cita con bloqueo optimista para evitar colisiones
// ============================================================

"use strict";

const prisma = require("../../config/database");
const { getSlotCache, setSlotCache, invalidarSlotCache } = require("../../config/redis");
const { slotDuration, maxSlotsList } = require("../../config/env");

// ── Utilidades de tiempo ─────────────────────────────────────

/** "HH:MM" → minutos desde medianoche */
function horaAMinutos(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutos desde medianoche → "HH:MM" */
function minutosAHora(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Genera array de slots {inicio, fin} para un día dado el horario de la sede. */
function generarSlotsDelDia(fecha, aperturaMinutos, cierreMinutos, duracion) {
  const slots = [];
  for (let inicio = aperturaMinutos; inicio + duracion <= cierreMinutos; inicio += duracion) {
    const fechaInicio = new Date(fecha);
    const [anio, mes, dia] = fecha.split("-").map(Number);
    fechaInicio.setFullYear(anio, mes - 1, dia);
    fechaInicio.setHours(Math.floor(inicio / 60), inicio % 60, 0, 0);

    const fechaFin = new Date(fechaInicio);
    fechaFin.setMinutes(fechaFin.getMinutes() + duracion);

    slots.push({
      inicio:    fechaInicio.toISOString(),
      fin:       fechaFin.toISOString(),
      inicioMin: inicio,
      label:     `${new Date(fechaInicio).toLocaleDateString("es-CO", {
                    weekday: "long", day: "numeric", month: "short",
                  })} — ${minutosAHora(inicio)}`,
    });
  }
  return slots;
}

// ── getAvailableSlots ────────────────────────────────────────

/**
 * Calcula los slots disponibles para una fecha, especialidad y sede.
 *
 * @param {string} fecha        — "YYYY-MM-DD"
 * @param {string} especialidad — nombre de la especialidad
 * @param {string} sedeSlug     — slug de la sede
 * @returns {Array<{inicio, fin, label}>}
 */
async function getAvailableSlots(fecha, especialidad, sedeSlug) {
  // 1. Intentar caché de Redis
  const cacheKey = `${sedeSlug}:${especialidad}:${fecha}`;
  const cached   = await getSlotCache(sedeSlug, `${especialidad}:${fecha}`);
  if (cached) return cached;

  // 2. Obtener sede y su horario para ese día de la semana
  const sede = await prisma.sede.findUnique({
    where:   { slug: sedeSlug, activa: true },
    include: { horarios: true },
  });

  if (!sede) throw new Error(`Sede '${sedeSlug}' no encontrada o inactiva.`);

  const fechaObj  = new Date(`${fecha}T00:00:00`);
  const diaSemana = fechaObj.getDay(); // 0=Dom

  const horario = sede.horarios.find(h => h.diaSemana === diaSemana);
  if (!horario) {
    // Sin horario ese día (ej: domingo)
    return [];
  }

  const duracion        = horario.duracionSlot || slotDuration;
  const aperturaMinutos = horaAMinutos(horario.apertura);
  const cierreMinutos   = horaAMinutos(horario.cierre);

  // 3. Generar todos los slots posibles del día
  const todosLosSlots = generarSlotsDelDia(fecha, aperturaMinutos, cierreMinutos, duracion);

  // 4. Obtener citas ya existentes en ese rango (con 1 min de buffer)
  const diaInicio = new Date(`${fecha}T00:00:00`);
  const diaFin    = new Date(`${fecha}T23:59:59`);

  const citasOcupadas = await prisma.cita.findMany({
    where: {
      sedeId:       sede.id,
      especialidad,
      estado:       { in: ["PENDIENTE", "CONFIRMADA"] },
      fechaInicio:  { gte: diaInicio, lt: diaFin },
    },
    select: { fechaInicio: true, fechaFin: true },
  });

  // 5. Filtrar slots ocupados
  const slotsLibres = todosLosSlots.filter(slot => {
    const slotInicio = new Date(slot.inicio).getTime();
    const slotFin    = new Date(slot.fin).getTime();

    return !citasOcupadas.some(cita => {
      const citaInicio = new Date(cita.fechaInicio).getTime();
      const citaFin    = new Date(cita.fechaFin).getTime();
      // Superposición: el slot empieza antes de que la cita termine
      //                Y termina después de que la cita empiece
      return slotInicio < citaFin && slotFin > citaInicio;
    });
  });

  // 6. Limpiar campo interno antes de devolver/cachear
  const resultado = slotsLibres
    .slice(0, maxSlotsList)
    .map(({ inicio, fin, label }) => ({ inicio, fin, label, sede: sede.nombre }));

  // 7. Guardar en caché
  await setSlotCache(sedeSlug, `${especialidad}:${fecha}`, resultado);

  return resultado;
}

// ── createAppointment ────────────────────────────────────────

/**
 * Crea una cita con verificación de colisión en el mismo momento de escritura.
 * Usa una transacción serializable para garantizar atomicidad.
 *
 * @param {object} data
 * @param {string} data.pacienteId
 * @param {string} data.sedeSlug
 * @param {string} data.especialidad
 * @param {string} data.fechaInicio  — ISO string
 * @param {string} data.fechaFin     — ISO string
 * @param {string} [data.asesorId]
 * @param {string} [data.motivoConsulta]
 * @returns {object} Cita creada
 */
async function createAppointment(data) {
  const { pacienteId, sedeSlug, especialidad, fechaInicio, fechaFin, asesorId, motivoConsulta } = data;

  // Validar fechas
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

  // Transacción serializable → garantiza que nadie más insertó el mismo slot
  // en los milisegundos que tardamos en verificar y crear.
  const cita = await prisma.$transaction(async (tx) => {
    // Re-verificar disponibilidad dentro de la transacción
    const colision = await tx.cita.findFirst({
      where: {
        sedeId:      sede.id,
        especialidad,
        estado:      { in: ["PENDIENTE", "CONFIRMADA"] },
        AND: [
          { fechaInicio: { lt: fin   } },
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
        sedeId:        sede.id,
        especialidad,
        fechaInicio:   inicio,
        fechaFin:      fin,
        estado:        "PENDIENTE",
        asesorId:      asesorId || null,
        motivoConsulta: motivoConsulta || null,
      },
      include: {
        paciente: { select: { nombre: true, phone: true, eps: true } },
        sede:     { select: { nombre: true } },
      },
    });
  }, {
    isolationLevel: "Serializable",
    timeout:        5000,
  });

  // Invalidar caché de slots para esa sede/fecha
  const fechaStr = inicio.toISOString().slice(0, 10);
  await invalidarSlotCache(sedeSlug, `${especialidad}:${fechaStr}`);

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

  // Liberar el slot en caché
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
