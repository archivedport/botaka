/**
 * ============================================================
 *  bot.js — IPS Salud Vida · WhatsApp Bot
 *  v2.0 — Mejoras: consulta/cancelación de citas, UX y errores
 * ============================================================
 *
 *  Flujos disponibles:
 *    • Agendar cita     → especialidad → EPS → doc → nombre → sede → slot → confirmación
 *    • Mis citas        → ver citas recientes → opción a cancelar
 *    • Cancelar cita    → selección → confirmación → cancelación
 *    • Horarios         → info por sede
 *    • Sedes            → detalle de cada sede
 *    • Hablar con asesor → handoff manual
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

// Timeout para llamadas al backend (ms)
const API_TIMEOUT = 8000;

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

/** Consulta slots disponibles al motor de calendario SQL. */
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

/** Crea la cita en PostgreSQL con protección anti-colisión. */
async function crearCita(pacienteId, sedeSlug, especialidad, slot) {
  const { data } = await axios.post(
    `${API_BASE}/api/calendar/appointments`,
    { pacienteId, sedeSlug, especialidad, fechaInicio: slot.inicio, fechaFin: slot.fin },
    { headers: apiHeaders(), timeout: API_TIMEOUT }
  );
  return data.cita;
}

/** Busca el paciente por phone para obtener su ID de BD. */
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

/** Obtiene las citas recientes del paciente (máx 8). */
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

/** Cancela una cita específica por ID. */
async function cancelarCitaAPI(citaId) {
  await axios.patch(
    `${API_BASE}/api/calendar/appointments/${citaId}/status`,
    { estado: "CANCELADA" },
    { headers: apiHeaders(), timeout: API_TIMEOUT }
  );
}

/* ============================================================
   SECCIÓN 3 · UTILIDADES DE FORMATO
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

/** Formatea una fecha ISO a texto legible en español. */
function fmtFecha(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("es-CO", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
}

/** Formatea hora corta HH:MM desde ISO. */
function fmtHora(iso) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}

/* ============================================================
   SECCIÓN 4 · MENÚS REUTILIZABLES
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
      { id: "menu_sedes",  title: "📍 Sedes"            },
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

async function menuSedesCita(to) {
  await sendButtons(to, {
    header:  "📍 ¿En qué sede prefieres tu cita?",
    body:    "Selecciona la sede:",
    footer:  "IPS Salud Vida",
    buttons: [
      { id: "sede_cita_centro", title: "🏢 Sede Centro" },
      { id: "sede_cita_norte",  title: "🏢 Sede Norte"  },
      { id: "sede_cita_sur",    title: "🏢 Sede Sur"    },
    ],
  });
}

async function menuSedes(to) {
  await sendButtons(to, {
    header:  "📍 Nuestras Sedes",
    body:    "¿Qué sede deseas consultar?",
    buttons: [
      { id: "sede_centro", title: "🏢 Sede Centro" },
      { id: "sede_norte",  title: "🏢 Sede Norte"  },
      { id: "sede_sur",    title: "🏢 Sede Sur"    },
    ],
  });
}

/** Muestra botones de acción post-consulta de citas. */
async function menuPostCitas(to) {
  await sendButtons(to, {
    body:    "¿Qué deseas hacer?",
    buttons: [
      { id: "menu_cita",      title: "📅 Agendar cita"    },
      { id: "citas_cancelar", title: "❌ Cancelar una cita" },
      { id: "menu_principal", title: "🏠 Menú principal"  },
    ],
  });
}

/* ============================================================
   SECCIÓN 5 · FLUJO DE SLOTS (motor SQL del backend)
   ============================================================ */

const SEDE_SLUG = {
  "Sede Centro": "sede-centro",
  "Sede Norte":  "sede-norte",
  "Sede Sur":    "sede-sur",
};

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
   SECCIÓN 6 · FLUJO DE CONSULTA DE CITAS
   ============================================================ */

/**
 * Busca al paciente, consulta sus citas y las muestra en un mensaje.
 * Luego ofrece opciones: agendar, cancelar, menú.
 */
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

  // Filtrar solo activas o recientes (últimas 5)
  const activas  = citas.filter(c => ["PENDIENTE", "CONFIRMADA"].includes(c.estado));
  const recientes = citas.filter(c => ["COMPLETADA", "NO_ASISTIO", "CANCELADA"].includes(c.estado)).slice(0, 3);
  const mostrar  = [...activas, ...recientes].slice(0, 5);

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

  // Construir mensaje con lista de citas
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
   SECCIÓN 7 · FLUJO DE CANCELACIÓN DE CITAS
   ============================================================ */

/**
 * Muestra la lista de citas cancelables (PENDIENTE o CONFIRMADA).
 * Guarda el mapa de índices en la sesión.
 */
async function iniciarCancelacion(phone) {
  const paciente = await obtenerPaciente(phone);

  if (!paciente) {
    await sendText(phone, "ℹ️ No encontré una cuenta a tu número. Si quieres agendar una cita, selecciona la opción del menú.");
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

  // Guardar las citas cancelables en sesión para luego recuperar el ID
  await saveSession(phone, {
    paso:  "citas_cancelar_sel",
    datos: { citasCancelables: cancelables.map(c => ({ id: c.id, especialidad: c.especialidad, fechaInicio: c.fechaInicio, sede: c.sede?.nombre })) },
  });

  await sendList(phone, {
    header:      "❌ Cancelar cita",
    body:        "Selecciona la cita que deseas cancelar:",
    footer:      "Puedes cancelar hasta 2h antes",
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

/**
 * Pide confirmación antes de cancelar la cita seleccionada.
 */
async function confirmarCancelacion(phone, indice, citasCancelables) {
  const cita = citasCancelables[indice];
  if (!cita) {
    await sendText(phone, "⚠️ No encontré esa cita. Vuelve a intentarlo.");
    await iniciarCancelacion(phone);
    return;
  }

  // Guardar la cita seleccionada en sesión para el paso de confirmación
  await saveSession(phone, {
    paso:  "citas_cancelar_conf",
    datos: { citaId: cita.id, citaLabel: `${cita.especialidad} el ${fmtFecha(cita.fechaInicio)} en ${cita.sede || "—"}` },
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
      { id: "cancelar_si",  title: "✅ Sí, cancelar"    },
      { id: "cancelar_no",  title: "↩️ No, volver"      },
    ],
  });
}

/* ============================================================
   SECCIÓN 8 · HANDLER PRINCIPAL
   ============================================================ */

async function handleBot(from, text, buttonId) {
  const msg     = text?.trim().toLowerCase() || "";
  const payload = buttonId || msg;

  // Si el chat está en MANUAL no procesar
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
        `🏢 *Sede Centro* — Lun–Vie 7:00–18:00 | Sáb 8:00–13:00\n` +
        `🏢 *Sede Norte*  — Lun–Vie 7:00–17:00 | Sáb 8:00–12:00\n` +
        `🏢 *Sede Sur*    — Lun–Vie 8:00–18:00 | Sáb 9:00–13:00\n\n` +
        `⚠️ Domingos y festivos: sin atención.\n` +
        `📞 Urgencias: 018000-000000`
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

  // ── "Mis citas" (estado transitorio post-display) ──────────
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

  // ── Cancelar: selección de cita ────────────────────────────
  if (sesion.paso === "citas_cancelar_sel") {
    const cancelables = sesion.datos?.citasCancelables || [];

    if (payload === "menu_principal" || msg === "cancelar" || msg === "salir") {
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

    const indice = parseInt(match[1]);
    await confirmarCancelacion(from, indice, cancelables);
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
          `✅ *Cita cancelada exitosamente.*\n\n` +
          `🩺 ${citaLabel}\n\n` +
          `Si necesitas reagendar, usa la opción *Agendar cita* del menú.`
        );
      } catch (err) {
        const esTimeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";
        await sendText(from, esTimeout
          ? "⏱️ El servidor tardó mucho en responder. Intenta en unos segundos."
          : "❌ No pudimos cancelar la cita en este momento. Por favor contacta a un asesor."
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
          { id: "cancelar_si", title: "✅ Sí, cancelar"  },
          { id: "cancelar_no", title: "↩️ No, volver"    },
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
    const doc = text?.trim().replace(/\D/g, ""); // Limpiar espacios y letras
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
    // Validar que no sean solo números
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
    const SEDES = {
      sede_cita_centro: "Sede Centro",
      sede_cita_norte:  "Sede Norte",
      sede_cita_sur:    "Sede Sur",
    };
    if (SEDES[payload]) {
      await saveSession(from, { paso: "cita_slot", datos: { ...sesion.datos, sede: SEDES[payload] } });
      await enviarSlots(from, SEDES[payload], sesion.datos.especialidad);
    } else {
      await sendText(from, "Por favor selecciona una sede de la lista 👆");
      await menuSedesCita(from);
    }
    return;
  }

  // ── Selección de slot ──────────────────────────────────────
  if (sesion.paso === "cita_slot") {
    const CAMBIO_SEDE = {
      sede_cita_centro: "Sede Centro",
      sede_cita_norte:  "Sede Norte",
      sede_cita_sur:    "Sede Sur",
    };
    if (CAMBIO_SEDE[payload]) {
      const nuevaSede = CAMBIO_SEDE[payload];
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
        `Para cancelar o ver tus citas usa *"Mis citas"* en el menú.`
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
    const INFO = {
      sede_centro: { nombre: "Sede Centro", dir: "Calle 10 #5-32, Piso 2",  tel: "(604) 321-0000", hora: "Lun–Vie 7–18 | Sáb 8–13", ref: "Frente al Parque Principal."      },
      sede_norte:  { nombre: "Sede Norte",  dir: "Carrera 45 #80-15",       tel: "(604) 321-0001", hora: "Lun–Vie 7–17 | Sáb 8–12", ref: "Junto al Centro Comercial Norte." },
      sede_sur:    { nombre: "Sede Sur",    dir: "Avenida 30 #12-40",       tel: "(604) 321-0002", hora: "Lun–Vie 8–18 | Sáb 9–13", ref: "Diagonal al Hospital del Sur."    },
    };
    if (INFO[payload]) {
      const s = INFO[payload];
      await sendText(from, `🏢 *${s.nombre}*\n\n📌 ${s.dir}\n📞 ${s.tel}\n🕐 ${s.hora}\n🗺️ ${s.ref}`);
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
