/**
 * ============================================================
 *  bot.js — IPS Salud Vida · WhatsApp Bot
 *  v2.1 — Sedes reales + consulta/cancelación de citas + UX
 * ============================================================
 */

"use strict";

const axios = require("axios");

const {
  getSession,
  saveSession,
  clearSession,
  getChatStatus,
  saveSlotSelection,
  getSlotSelection,
  clearSlotSelection,
} = require("./src/config/redis");

const { meta } = require("./src/config/env");

const WA_URL     = `${meta.baseUrl()}/${meta.phoneId}/messages`;
const WA_HEADERS = {
  Authorization:  `Bearer ${meta.token}`,
  "Content-Type": "application/json",
};

const API_BASE          = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const BOT_SERVICE_TOKEN = process.env.BOT_SERVICE_TOKEN || process.env.JWT_SECRET;
const API_TIMEOUT       = 8000;

/* ============================================================
   SECCIÓN 1 · ENVÍO DE MENSAJES
   ============================================================ */

async function sendText(to, body) {
  try {
    await axios.post(WA_URL,
      { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } },
      { headers: WA_HEADERS }
    );
  } catch (e) {
    console.error("❌ sendText:", e.response?.data || e.message);
  }
}

async function sendButtons(to, { header, body, footer, buttons }) {
  try {
    await axios.post(WA_URL,
      {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "button",
          ...(header && { header: { type: "text", text: header } }),
          body:   { text: body },
          ...(footer && { footer: { text: footer } }),
          action: {
            buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })),
          },
        },
      },
      { headers: WA_HEADERS }
    );
  } catch (e) {
    console.error("❌ sendButtons:", e.response?.data || e.message);
  }
}

async function sendList(to, { header, body, footer, buttonLabel, sections }) {
  try {
    await axios.post(WA_URL,
      {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "list",
          ...(header && { header: { type: "text", text: header } }),
          body:   { text: body },
          ...(footer && { footer: { text: footer } }),
          action: { button: buttonLabel || "Ver opciones", sections },
        },
      },
      { headers: WA_HEADERS }
    );
  } catch (e) {
    console.error("❌ sendList:", e.response?.data || e.message);
  }
}

/* ============================================================
   SECCIÓN 2 · LLAMADAS AL BACKEND INTERNO
   ============================================================ */

const apiHeaders = () => ({
  Authorization:  `Bearer ${BOT_SERVICE_TOKEN}`,
  "Content-Type": "application/json",
});

async function obtenerSlots(sedeSlug, especialidad) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + 1);
  const { data } = await axios.get(`${API_BASE}/api/calendar/slots`, {
    params:  { fecha: fecha.toISOString().slice(0, 10), especialidad, sede: sedeSlug },
    headers: apiHeaders(),
    timeout: API_TIMEOUT,
  });
  return data.slots || [];
}

async function crearCita(pacienteId, sedeSlug, especialidad, slot) {
  const { data } = await axios.post(
    `${API_BASE}/api/calendar/appointments`,
    { pacienteId, sedeSlug, especialidad, fechaInicio: slot.inicio, fechaFin: slot.fin },
    { headers: apiHeaders(), timeout: API_TIMEOUT }
  );
  return data.cita;
}

async function obtenerPaciente(phone) {
  try {
    const { data } = await axios.get(`${API_BASE}/api/patients/by-phone/${phone}`, {
      headers: apiHeaders(),
      timeout: API_TIMEOUT,
    });
    return data.paciente;
  } catch {
    return null;
  }
}

async function obtenerCitasPaciente(pacienteId) {
  try {
    const { data } = await axios.get(`${API_BASE}/api/calendar/appointments/${pacienteId}`, {
      params:  { limit: 8, page: 1 },
      headers: apiHeaders(),
      timeout: API_TIMEOUT,
    });
    return data.citas || [];
  } catch {
    return [];
  }
}

async function cancelarCitaAPI(citaId) {
  await axios.patch(
    `${API_BASE}/api/calendar/appointments/${citaId}/status`,
    { estado: "CANCELADA" },
    { headers: apiHeaders(), timeout: API_TIMEOUT }
  );
}

/* ============================================================
   SECCIÓN 3 · CONSTANTES DE SEDES
   ============================================================ */

// Nombre visible → slug de BD
const SEDE_SLUG = {
  "Montería":       "sede-monteria",
  "Tierralta":      "sede-tierralta",
  "Ciénaga de Oro": "sede-cdo",
  "Cereté":         "sede-cerete",
  "San Carlos":     "sede-san-carlos",
  "Valencia":       "sede-valencia",
};

// ID de botón / lista → nombre visible
const SEDES_MAP = {
  sede_cita_monteria:   "Montería",
  sede_cita_tierralta:  "Tierralta",
  sede_cita_cdo:        "Ciénaga de Oro",
  sede_cita_cerete:     "Cereté",
  sede_cita_sancarlos:  "San Carlos",
  sede_cita_valencia:   "Valencia",
};

// Información pública de cada sede (horarios reales del Excel)
// NOTA: actualiza dir y tel con los datos reales antes de producción.
const SEDES_INFO = {
  sede_monteria: {
    nombre:  "Montería",
    dir:     "Dirección — actualizar",
    tel:     "PENDIENTE",
    horario: "Lun–Vie: 11:00–11:30 (mañana) · 17:00–17:30 (tarde)",
    nota:    "Atención de lunes a viernes en dos jornadas.",
  },
  sede_tierralta: {
    nombre:  "Tierralta",
    dir:     "Dirección — actualizar",
    tel:     "PENDIENTE",
    horario: "Lun/Mié/Vie: 16:40–17:10 · Mar/Jue: 11:00–11:30 y 16:40–17:10",
    nota:    "Martes y jueves tienen jornada mañana y tarde.",
  },
  sede_cdo: {
    nombre:  "Ciénaga de Oro",
    dir:     "Dirección — actualizar",
    tel:     "PENDIENTE",
    horario: "Lun–Vie: 11:00–11:20 (mañana) · 16:50–17:00 (tarde)",
    nota:    "Atención de lunes a viernes.",
  },
  sede_cerete: {
    nombre:  "Cereté",
    dir:     "Dirección — actualizar",
    tel:     "PENDIENTE",
    horario: "Lun/Mié/Vie: 11:00–11:30 · Mar/Jue: 13:30, 14:30, 15:30",
    nota:    "Martes y jueves con atención solo en tarde.",
  },
  sede_sancarlos: {
    nombre:  "San Carlos",
    dir:     "Dirección — actualizar",
    tel:     "PENDIENTE",
    horario: "Martes y Jueves: 07:40, 08:30, 09:20, 10:00",
    nota:    "Atención solo martes y jueves en la mañana.",
  },
  sede_valencia: {
    nombre:  "Valencia",
    dir:     "Dirección — actualizar",
    tel:     "PENDIENTE",
    horario: "Lun/Mié/Vie: 10:40, 10:50, 11:00",
    nota:    "Atención lunes, miércoles y viernes.",
  },
};

/* ============================================================
   SECCIÓN 4 · UTILIDADES
   ============================================================ */

const ESTADO_LABEL = {
  PENDIENTE:  "🟡 Pendiente",
  CONFIRMADA: "🟢 Confirmada",
  CANCELADA:  "🔴 Cancelada",
  COMPLETADA: "✅ Completada",
  NO_ASISTIO: "⚠️ No asistió",
};

const ESP_CORTA = {
  "Medicina General": "Med. General",
  "Odontología":      "Odontología",
  "Psicología":       "Psicología",
  "Nutrición":        "Nutrición",
  "Especialistas":    "Especialista",
};

function fmtFecha(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtHora(iso) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}

/* ============================================================
   SECCIÓN 5 · MENÚS
   ============================================================ */

async function menuPrincipal(to) {
  await sendButtons(to, {
    header:  "🏥 IPS Salud Vida",
    body:    "¡Bienvenido! ¿En qué podemos ayudarte hoy?",
    footer:  "Selecciona una opción",
    buttons: [
      { id: "menu_cita",     title: "📅 Agendar cita"  },
      { id: "menu_miscitas", title: "📋 Mis citas"      },
      { id: "menu_horarios", title: "🕐 Horarios"       },
    ],
  });
  await sendButtons(to, {
    body:    "Más opciones:",
    buttons: [
      { id: "menu_sedes",  title: "📍 Sedes"              },
      { id: "menu_asesor", title: "👨‍💼 Hablar con asesor" },
    ],
  });
}

async function menuEspecialidades(to) {
  await sendList(to, {
    header:      "📅 Agendar Cita",
    body:        "Selecciona el tipo de servicio:",
    footer:      "IPS Salud Vida",
    buttonLabel: "Ver servicios",
    sections: [{ title: "Servicios disponibles", rows: [
      { id: "esp_medicina",     title: "🩺 Medicina General" },
      { id: "esp_odonto",       title: "🦷 Odontología"      },
      { id: "esp_psicologia",   title: "🧠 Psicología"       },
      { id: "esp_nutricion",    title: "🥗 Nutrición"        },
      { id: "esp_especialista", title: "👨‍⚕️ Especialistas" },
    ]}],
  });
}

async function menuEPS(to, especialidad) {
  await sendList(to, {
    header:      `🩺 ${especialidad}`,
    body:        "¿Con qué EPS estás afiliado?",
    footer:      "IPS Salud Vida",
    buttonLabel: "Seleccionar EPS",
    sections: [{ title: "EPS / Aseguradora", rows: [
      { id: "eps_sura",       title: "Sura"                 },
      { id: "eps_sanitas",    title: "Sanitas"              },
      { id: "eps_nueva",      title: "Nueva EPS"            },
      { id: "eps_coosalud",   title: "Coosalud"             },
      { id: "eps_particular", title: "Particular (sin EPS)" },
      { id: "eps_otra",       title: "Otra"                 },
    ]}],
  });
}

// Lista de sedes para seleccionar en el agendamiento
async function menuSedesCita(to) {
  await sendList(to, {
    header:      "📍 ¿En qué sede prefieres tu cita?",
    body:        "Selecciona la sede:",
    footer:      "IPS Salud Vida",
    buttonLabel: "Ver sedes",
    sections: [{
      title: "Sedes disponibles",
      rows: [
        { id: "sede_cita_monteria",  title: "🏢 Montería",       description: "Lun–Vie mañana y tarde"    },
        { id: "sede_cita_tierralta", title: "🏢 Tierralta",      description: "Lun–Vie mañana/tarde"      },
        { id: "sede_cita_cdo",       title: "🏢 Ciénaga de Oro", description: "Lun–Vie mañana y tarde"    },
        { id: "sede_cita_cerete",    title: "🏢 Cereté",         description: "Lun–Vie mañana/tarde"      },
        { id: "sede_cita_sancarlos", title: "🏢 San Carlos",     description: "Solo mar y jue"            },
        { id: "sede_cita_valencia",  title: "🏢 Valencia",       description: "Lun, mié y vie"            },
      ],
    }],
  });
}

// Lista de sedes para consultar info
async function menuSedes(to) {
  await sendList(to, {
    header:      "📍 Nuestras Sedes",
    body:        "¿Qué sede deseas consultar?",
    footer:      "IPS Salud Vida",
    buttonLabel: "Ver sedes",
    sections: [{
      title: "Sedes",
      rows: [
        { id: "sede_monteria",  title: "🏢 Montería"        },
        { id: "sede_tierralta", title: "🏢 Tierralta"       },
        { id: "sede_cdo",       title: "🏢 Ciénaga de Oro"  },
        { id: "sede_cerete",    title: "🏢 Cereté"          },
        { id: "sede_sancarlos", title: "🏢 San Carlos"      },
        { id: "sede_valencia",  title: "🏢 Valencia"        },
      ],
    }],
  });
}

async function menuPostCitas(to) {
  await sendButtons(to, {
    body:    "¿Qué deseas hacer?",
    buttons: [
      { id: "menu_cita",      title: "📅 Agendar cita"     },
      { id: "citas_cancelar", title: "❌ Cancelar una cita" },
      { id: "menu_principal", title: "🏠 Menú principal"   },
    ],
  });
}

/* ============================================================
   SECCIÓN 6 · FLUJO DE SLOTS
   ============================================================ */

async function enviarSlots(to, sedeNombre, especialidad) {
  await sendText(to, `🔍 Consultando disponibilidad en *${sedeNombre}*... ⏳`);

  let slots;
  try {
    slots = await obtenerSlots(SEDE_SLUG[sedeNombre], especialidad);
  } catch (err) {
    console.error("❌ Error obteniendo slots:", err.message);
    const esTimeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";
    await sendText(to, esTimeout
      ? "⏱️ El servidor tardó demasiado en responder. Intenta en unos segundos."
      : "⚠️ No pudimos consultar la disponibilidad en este momento. Intenta en unos minutos."
    );
    return false;
  }

  if (!slots.length) {
    await sendText(to, `😔 Sin disponibilidad en *${sedeNombre}* para mañana.\n¿Deseas consultar en otra sede?`);
    await menuSedesCita(to);
    return false;
  }

  await saveSlotSelection(to, slots);

  await sendList(to, {
    header:      `📅 Disponibilidad — ${sedeNombre}`,
    body:        `Selecciona tu horario para *${especialidad}*:`,
    footer:      "Horarios disponibles en tiempo real",
    buttonLabel: "Ver horarios",
    sections: [{ title: "Próximos horarios libres", rows: slots.map((s, i) => ({
      id:          `slot_${i}`,
      title:       s.label.slice(0, 24),
      description: sedeNombre,
    })) }],
  });

  return true;
}

/* ============================================================
   SECCIÓN 7 · FLUJO DE "MIS CITAS"
   ============================================================ */

async function mostrarMisCitas(phone) {
  const paciente = await obtenerPaciente(phone);

  if (!paciente) {
    await sendText(phone,
      `📋 *Mis citas*\n\nNo encontré una cuenta asociada a este número.\n\n` +
      `¿Deseas agendar tu primera cita con nosotros?`
    );
    await sendButtons(phone, {
      body:    "¿Qué deseas hacer?",
      buttons: [
        { id: "menu_cita",      title: "📅 Agendar cita"   },
        { id: "menu_principal", title: "🏠 Menú principal" },
      ],
    });
    return;
  }

  let citas = [];
  try {
    citas = await obtenerCitasPaciente(paciente.id);
  } catch {
    await sendText(phone, "⚠️ No pudimos cargar tus citas en este momento. Intenta más tarde.");
    await menuPrincipal(phone);
    return;
  }

  const activas   = citas.filter(c => ["PENDIENTE", "CONFIRMADA"].includes(c.estado));
  const recientes = citas.filter(c => ["COMPLETADA", "NO_ASISTIO", "CANCELADA"].includes(c.estado)).slice(0, 3);
  const mostrar   = [...activas, ...recientes].slice(0, 5);

  if (!mostrar.length) {
    await sendText(phone,
      `📋 *Mis citas*\n\nHola${paciente.nombre ? `, *${paciente.nombre.split(" ")[0]}*` : ""}! 👋\n\n` +
      `No tienes citas registradas aún.`
    );
    await sendButtons(phone, {
      body:    "¿Deseas agendar una cita?",
      buttons: [
        { id: "menu_cita",      title: "📅 Agendar cita"   },
        { id: "menu_principal", title: "🏠 Menú principal" },
      ],
    });
    return;
  }

  const nombre = paciente.nombre ? `*${paciente.nombre.split(" ")[0]}*` : "";
  let msg = `📋 *Mis citas* — Hola${nombre ? `, ${nombre}` : ""}! 👋\n\n`;

  if (activas.length) {
    msg += `✅ *Próximas citas activas:*\n`;
    activas.forEach((c, i) => {
      msg += `\n${i + 1}. 🩺 *${c.especialidad}*\n`;
      msg += `   📅 ${fmtFecha(c.fechaInicio)}\n`;
      msg += `   📍 ${c.sede?.nombre || "—"}\n`;
      msg += `   ${ESTADO_LABEL[c.estado] || c.estado}\n`;
    });
  }

  if (recientes.length) {
    msg += `\n📁 *Historial reciente:*\n`;
    recientes.forEach(c => {
      msg += `\n• ${c.especialidad} — ${new Date(c.fechaInicio).toLocaleDateString("es-CO", { day: "numeric", month: "short" })} (${ESTADO_LABEL[c.estado] || c.estado})\n`;
    });
  }

  await sendText(phone, msg);
  await menuPostCitas(phone);
}

/* ============================================================
   SECCIÓN 8 · FLUJO DE CANCELACIÓN
   ============================================================ */

async function iniciarCancelacion(phone) {
  const paciente = await obtenerPaciente(phone);

  if (!paciente) {
    await sendText(phone, "ℹ️ No encontré una cuenta asociada a tu número.");
    await menuPrincipal(phone);
    return;
  }

  let citas = [];
  try {
    citas = await obtenerCitasPaciente(paciente.id);
  } catch {
    await sendText(phone, "⚠️ No pudimos cargar tus citas. Intenta en unos minutos.");
    await menuPrincipal(phone);
    return;
  }

  const cancelables = citas.filter(c => ["PENDIENTE", "CONFIRMADA"].includes(c.estado));

  if (!cancelables.length) {
    await sendText(phone, "ℹ️ No tienes citas pendientes o confirmadas que puedas cancelar.");
    await sendButtons(phone, {
      body:    "¿Qué deseas hacer?",
      buttons: [
        { id: "menu_cita",      title: "📅 Agendar cita"   },
        { id: "menu_principal", title: "🏠 Menú principal" },
      ],
    });
    return;
  }

  await saveSession(phone, {
    paso:  "citas_cancelar_sel",
    datos: {
      citasCancelables: cancelables.map(c => ({
        id:          c.id,
        especialidad: c.especialidad,
        fechaInicio: c.fechaInicio,
        sede:        c.sede?.nombre,
      })),
    },
  });

  await sendList(phone, {
    header:      "❌ Cancelar cita",
    body:        "Selecciona la cita que deseas cancelar:",
    footer:      "Solo citas pendientes o confirmadas",
    buttonLabel: "Ver citas",
    sections: [{ title: "Mis citas activas", rows: cancelables.map((c, i) => {
      const esp   = ESP_CORTA[c.especialidad] || c.especialidad.slice(0, 12);
      const hora  = fmtHora(c.fechaInicio);
      const fecha = new Date(c.fechaInicio).toLocaleDateString("es-CO", { day: "numeric", month: "short" });
      return {
        id:          `cancelar_${i}`,
        title:       `${esp} ${hora}`.slice(0, 24),
        description: `${fecha} · ${c.sede?.nombre || "—"} · ${ESTADO_LABEL[c.estado] || c.estado}`.slice(0, 72),
      };
    })}],
  });
}

async function confirmarCancelacion(phone, indice, citasCancelables) {
  const cita = citasCancelables[indice];
  if (!cita) {
    await sendText(phone, "⚠️ No encontré esa cita. Vuelve a intentarlo.");
    await iniciarCancelacion(phone);
    return;
  }

  await saveSession(phone, {
    paso:  "citas_cancelar_conf",
    datos: {
      citaId:    cita.id,
      citaLabel: `${cita.especialidad} el ${fmtFecha(cita.fechaInicio)} en ${cita.sede || "—"}`,
    },
  });

  await sendButtons(phone, {
    header: "❌ Confirmar cancelación",
    body:
      `¿Estás seguro de cancelar esta cita?\n\n` +
      `🩺 *${cita.especialidad}*\n` +
      `📅 ${fmtFecha(cita.fechaInicio)}\n` +
      `📍 ${cita.sede || "—"}`,
    footer: "Esta acción no se puede deshacer",
    buttons: [
      { id: "cancelar_si", title: "✅ Sí, cancelar"  },
      { id: "cancelar_no", title: "↩️ No, volver"    },
    ],
  });
}

/* ============================================================
   SECCIÓN 9 · HANDLER PRINCIPAL
   ============================================================ */

async function handleBot(from, text, buttonId) {
  const msg     = text?.trim().toLowerCase() || "";
  const payload = buttonId || msg;

  if (await getChatStatus(from) === "MANUAL") return;

  const sesion = await getSession(from);

  // ── Reinicio universal ─────────────────────────────────────
  if (
    ["hola", "menu", "menú", "inicio", "start", "ayuda", "help"].includes(msg) ||
    payload === "menu_principal"
  ) {
    await clearSession(from);
    await saveSession(from, { paso: "menu", datos: {} });
    await menuPrincipal(from);
    return;
  }

  // ── Menú principal ─────────────────────────────────────────
  if (sesion.paso === "inicio" || sesion.paso === "menu") {

    if (payload === "menu_cita") {
      await saveSession(from, { paso: "cita_especialidad", datos: {} });
      await menuEspecialidades(from);

    } else if (payload === "menu_miscitas" || payload === "mis citas") {
      await saveSession(from, { paso: "mis_citas", datos: {} });
      await mostrarMisCitas(from);

    } else if (payload === "citas_cancelar") {
      await iniciarCancelacion(from);

    } else if (payload === "menu_horarios") {
      await sendText(from,
        `🕐 *Horarios de atención:*\n\n` +
        `🏢 *Montería* — Lun–Vie 11:00–11:30 · tarde 17:00–17:30\n` +
        `🏢 *Tierralta* — Lun/Mié/Vie tarde 16:40–17:10 · Mar/Jue mañana y tarde\n` +
        `🏢 *Ciénaga de Oro* — Lun–Vie 11:00–11:20 · tarde 16:50–17:00\n` +
        `🏢 *Cereté* — Lun/Mié/Vie 11:00–11:30 · todos tarde 13:30–15:30\n` +
        `🏢 *San Carlos* — Solo Mar y Jue 7:40–10:00\n` +
        `🏢 *Valencia* — Solo Lun/Mié/Vie 10:40–11:00\n\n` +
        `⚠️ Domingos y festivos: sin atención.`
      );
      await sendButtons(from, {
        body:    "¿Deseas hacer algo más?",
        buttons: [
          { id: "menu_cita",      title: "📅 Agendar cita"   },
          { id: "menu_sedes",     title: "📍 Ver sedes"       },
          { id: "menu_principal", title: "🏠 Menú principal" },
        ],
      });

    } else if (payload === "menu_sedes") {
      await saveSession(from, { paso: "sedes", datos: {} });
      await menuSedes(from);

    } else if (payload === "menu_asesor") {
      await saveSession(from, { paso: "asesor_motivo", datos: {} });
      await sendText(from,
        `👨‍💼 Con gusto te conectamos con un asesor.\n\n` +
        `¿*Cuál es el motivo de tu consulta?*\n_(Escribe tu mensaje)_`
      );

    } else {
      await menuPrincipal(from);
    }
    return;
  }

  // ── "Mis citas" ────────────────────────────────────────────
  if (sesion.paso === "mis_citas") {
    if (payload === "citas_cancelar") {
      await iniciarCancelacion(from);
    } else if (payload === "menu_cita") {
      await saveSession(from, { paso: "cita_especialidad", datos: {} });
      await menuEspecialidades(from);
    } else {
      await saveSession(from, { paso: "menu", datos: {} });
      await menuPrincipal(from);
    }
    return;
  }

  // ── Cancelar: selección ────────────────────────────────────
  if (sesion.paso === "citas_cancelar_sel") {
    const cancelables = sesion.datos?.citasCancelables || [];

    if (payload === "menu_principal") {
      await saveSession(from, { paso: "menu", datos: {} });
      await menuPrincipal(from);
      return;
    }

    const match = payload.match(/^cancelar_(\d+)$/);
    if (!match) {
      await sendText(from, "Por favor selecciona una cita de la lista 👆");
      await iniciarCancelacion(from);
      return;
    }

    await confirmarCancelacion(from, parseInt(match[1]), cancelables);
    return;
  }

  // ── Cancelar: confirmación ─────────────────────────────────
  if (sesion.paso === "citas_cancelar_conf") {
    const { citaId, citaLabel } = sesion.datos || {};

    if (payload === "cancelar_si") {
      if (!citaId) {
        await sendText(from, "⚠️ Ocurrió un error. Por favor intenta nuevamente.");
        await menuPrincipal(from);
        return;
      }

      await sendText(from, "⏳ Procesando cancelación...");

      try {
        await cancelarCitaAPI(citaId);
        await sendText(from,
          `✅ *Cita cancelada exitosamente.*\n\n🩺 ${citaLabel}\n\n` +
          `Si necesitas reagendar, usa la opción *Agendar cita* del menú.`
        );
      } catch (err) {
        const esTimeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";
        await sendText(from, esTimeout
          ? "⏱️ El servidor tardó mucho en responder. Intenta en unos segundos."
          : "❌ No pudimos cancelar la cita. Por favor contacta a un asesor."
        );
      }

      await clearSession(from);
      await saveSession(from, { paso: "menu", datos: {} });
      await sendButtons(from, {
        body:    "¿Deseas hacer algo más?",
        buttons: [
          { id: "menu_cita",      title: "📅 Nueva cita"     },
          { id: "menu_miscitas",  title: "📋 Mis citas"       },
          { id: "menu_principal", title: "🏠 Menú principal" },
        ],
      });

    } else if (payload === "cancelar_no") {
      await sendText(from, "↩️ Cancelación abortada. Tu cita sigue activa.");
      await saveSession(from, { paso: "menu", datos: {} });
      await menuPostCitas(from);

    } else {
      await sendButtons(from, {
        body:    "¿Confirmas la cancelación?",
        buttons: [
          { id: "cancelar_si", title: "✅ Sí, cancelar" },
          { id: "cancelar_no", title: "↩️ No, volver"   },
        ],
      });
    }
    return;
  }

  // ── Especialidad ───────────────────────────────────────────
  if (sesion.paso === "cita_especialidad") {
    const ESP = {
      esp_medicina:     "Medicina General",
      esp_odonto:       "Odontología",
      esp_psicologia:   "Psicología",
      esp_nutricion:    "Nutrición",
      esp_especialista: "Especialistas",
    };
    if (ESP[payload]) {
      await saveSession(from, { paso: "cita_eps", datos: { ...sesion.datos, especialidad: ESP[payload] } });
      await menuEPS(from, ESP[payload]);
    } else {
      await sendText(from, "Por favor selecciona una especialidad de la lista 👆");
      await menuEspecialidades(from);
    }
    return;
  }

  // ── EPS ────────────────────────────────────────────────────
  if (sesion.paso === "cita_eps") {
    const EPS = {
      eps_sura:       "Sura",
      eps_sanitas:    "Sanitas",
      eps_nueva:      "Nueva EPS",
      eps_coosalud:   "Coosalud",
      eps_particular: "Particular",
      eps_otra:       "Otra",
    };
    if (EPS[payload]) {
      await saveSession(from, { paso: "cita_documento", datos: { ...sesion.datos, eps: EPS[payload] } });
      await sendText(from, `✅ EPS: *${EPS[payload]}*\n\nEscribe tu *número de documento* (solo números):`);
    } else {
      await sendText(from, "Por favor selecciona tu EPS de la lista 👆");
      await menuEPS(from, sesion.datos.especialidad);
    }
    return;
  }

  // ── Documento ──────────────────────────────────────────────
  if (sesion.paso === "cita_documento") {
    const doc = text?.trim().replace(/\D/g, "");
    if (doc && doc.length >= 5 && doc.length <= 12) {
      await saveSession(from, { paso: "cita_nombre", datos: { ...sesion.datos, documento: doc } });
      await sendText(from, `✅ Documento: *${doc}*\n\nAhora escribe tu *nombre completo:*`);
    } else if (!doc || doc.length < 5) {
      await sendText(from, "⚠️ El documento debe tener al menos 5 dígitos. Intenta de nuevo:");
    } else {
      await sendText(from, "⚠️ Documento demasiado largo. Verifica e intenta de nuevo:");
    }
    return;
  }

  // ── Nombre ─────────────────────────────────────────────────
  if (sesion.paso === "cita_nombre") {
    const nombre = text?.trim();
    if (!nombre || nombre.length < 3) {
      await sendText(from, "⚠️ Por favor escribe tu nombre completo (mínimo 3 caracteres):");
      return;
    }
    if (/^\d+$/.test(nombre)) {
      await sendText(from, "⚠️ El nombre no puede ser solo números. Escribe tu nombre completo:");
      return;
    }
    await saveSession(from, { paso: "cita_sede", datos: { ...sesion.datos, nombre } });
    await sendText(from, `Gracias, *${nombre}*. 😊\n\nSelecciona la sede para tu cita:`);
    await menuSedesCita(from);
    return;
  }

  // ── Sede de la cita ────────────────────────────────────────
  if (sesion.paso === "cita_sede") {
    if (SEDES_MAP[payload]) {
      const sede = SEDES_MAP[payload];
      await saveSession(from, { paso: "cita_slot", datos: { ...sesion.datos, sede } });
      await enviarSlots(from, sede, sesion.datos.especialidad);
    } else {
      await sendText(from, "Por favor selecciona una sede de la lista 👆");
      await menuSedesCita(from);
    }
    return;
  }

  // ── Selección de slot ──────────────────────────────────────
  if (sesion.paso === "cita_slot") {
    // Cambio de sede desde pantalla de slots
    if (SEDES_MAP[payload]) {
      const nuevaSede = SEDES_MAP[payload];
      await saveSession(from, { ...sesion, datos: { ...sesion.datos, sede: nuevaSede } });
      await enviarSlots(from, nuevaSede, sesion.datos.especialidad);
      return;
    }

    const slotMatch = payload.match(/^slot_(\d+)$/);
    if (!slotMatch) {
      await sendText(from, "Por favor selecciona un horario de la lista 👆");
      await enviarSlots(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    const slots = await getSlotSelection(from);
    if (!slots) {
      await sendText(from, "⏱️ Los horarios expiraron. Volvemos a consultar...");
      await enviarSlots(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    const slot = slots[parseInt(slotMatch[1])];
    if (!slot) {
      await sendText(from, "⚠️ Ese horario ya no está disponible. Selecciona otro:");
      await enviarSlots(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    await sendText(from, "⏳ Registrando tu cita...");

    try {
      const paciente = await obtenerPaciente(from);
      const cita     = await crearCita(
        paciente?.id,
        SEDE_SLUG[sesion.datos.sede],
        sesion.datos.especialidad,
        slot
      );

      await sendText(from,
        `🎉 *¡Cita registrada exitosamente!*\n\n` +
        `👤 ${sesion.datos.nombre}\n` +
        `🪪 ${sesion.datos.documento}\n` +
        `🏥 ${sesion.datos.especialidad} · ${sesion.datos.eps}\n` +
        `📅 ${slot.label}\n` +
        `📍 ${sesion.datos.sede}\n` +
        `🆔 Ref: \`${cita.id.slice(-8).toUpperCase()}\`\n\n` +
        `✅ Recibirás confirmación pronto.\n` +
        `Para ver o cancelar tu cita usa *"Mis citas"* en el menú.`
      );
    } catch (err) {
      const esColision = err.response?.status === 409;
      const esTimeout  = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";

      if (esColision) {
        await sendText(from, "⚠️ Ese horario acaba de ser reservado por otra persona. Selecciona otro:");
      } else if (esTimeout) {
        await sendText(from, "⏱️ El servidor tardó demasiado. Intenta seleccionar el horario nuevamente:");
      } else {
        await sendText(from, "❌ Ocurrió un error al registrar tu cita. Por favor intenta nuevamente:");
      }
      await enviarSlots(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    await clearSlotSelection(from);
    await saveSession(from, { paso: "menu", datos: {} });
    await sendButtons(from, {
      body:    "¿Deseas hacer algo más?",
      buttons: [
        { id: "menu_miscitas",  title: "📋 Mis citas"       },
        { id: "menu_cita",      title: "📅 Nueva cita"      },
        { id: "menu_principal", title: "🏠 Menú principal" },
      ],
    });
    return;
  }

  // ── Información de sedes ───────────────────────────────────
  if (sesion.paso === "sedes") {
    // Mapeo de IDs de lista → keys de SEDES_INFO
    const SEDE_ID_MAP = {
      sede_monteria:  "sede_monteria",
      sede_tierralta: "sede_tierralta",
      sede_cdo:       "sede_cdo",
      sede_cerete:    "sede_cerete",
      sede_sancarlos: "sede_sancarlos",
      sede_valencia:  "sede_valencia",
    };

    const sedeKey = SEDE_ID_MAP[payload];
    if (sedeKey && SEDES_INFO[sedeKey]) {
      const s = SEDES_INFO[sedeKey];
      await sendText(from,
        `🏢 *${s.nombre}*\n\n` +
        `📌 ${s.dir}\n` +
        `📞 ${s.tel}\n` +
        `🕐 ${s.horario}\n` +
        `ℹ️ ${s.nota}`
      );
      await sendButtons(from, {
        body:    "¿Qué deseas hacer?",
        buttons: [
          { id: "menu_cita",      title: "📅 Agendar cita"  },
          { id: "menu_sedes",     title: "📍 Ver otra sede" },
          { id: "menu_principal", title: "🏠 Menú principal" },
        ],
      });
      await saveSession(from, { paso: "menu", datos: {} });
    } else {
      await menuSedes(from);
    }
    return;
  }

  // ── Solicitud de asesor ────────────────────────────────────
  if (sesion.paso === "asesor_motivo") {
    const motivo = text?.trim();
    if (!motivo || motivo.length < 3) {
      await sendText(from, "Por favor cuéntanos el motivo de tu consulta ✍️ (al menos 3 caracteres):");
      return;
    }
    await sendText(from,
      `⏳ *Conectando con un asesor...*\n\nMotivo: _${motivo}_\n\n` +
      `Un asesor se comunicará contigo en breve. 🔔\n` +
      `Mientras esperas, puedes seguir enviando mensajes.`
    );
    await saveSession(from, { paso: "con_asesor", datos: { motivo } });
    return;
  }

  // ── Fallback global ────────────────────────────────────────
  await clearSession(from);
  await saveSession(from, { paso: "menu", datos: {} });
  await sendText(from, "😅 No entendí ese mensaje. Aquí tienes el menú principal:");
  await menuPrincipal(from);
}

/* ============================================================
   EXPORTACIONES
   ============================================================ */
module.exports = { handleBot, sendText, sendButtons, menuPrincipal, saveSession };
