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

const API_BASE   = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const API_TIMEOUT = 8000;

// ── Auth: el bot se loguea y obtiene un JWT real ──────────────
let _botToken    = null;
let _tokenExpiry = 0;

async function getBotToken() {
  if (_botToken && Date.now() < _tokenExpiry - 5 * 60 * 1000) return _botToken;
  const { data } = await axios.post(
    `${API_BASE}/api/auth/login`,
    {
      email:    process.env.BOT_EMAIL    || "admin@ipssaludvida.com",
      password: process.env.BOT_PASSWORD || process.env.ADMIN_PASSWORD || "Admin123!",
    },
    { timeout: API_TIMEOUT }
  );
  _botToken    = data.token;
  _tokenExpiry = Date.now() + 8 * 60 * 60 * 1000;
  console.log("✅ Bot: token renovado");
  return _botToken;
}

/* ============================================================
   SECCIÓN 1 · ENVÍO DE MENSAJES
   ============================================================ */

async function sendText(to, body) {
  try {
    await axios.post(WA_URL,
      { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } },
      { headers: WA_HEADERS }
    );
    // Guardar mensaje del bot en BD
    await axios.post(
      `${API_BASE}/api/chat/bot-message`,
      { phone: to, texto: body },
      { headers: await apiHeaders(), timeout: 3000 }
    ).catch(() => {}); // silencioso si falla
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
    // Guardar en historial — construir texto legible con header + body + opciones
    const textoGuardar = [
      header ? `*${header}*` : null,
      body,
      buttons.map(b => `› ${b.title}`).join("\n"),
    ].filter(Boolean).join("\n");
    await axios.post(
      `${API_BASE}/api/chat/bot-message`,
      { phone: to, texto: textoGuardar },
      { headers: await apiHeaders(), timeout: 3000 }
    ).catch(() => {});
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
    // Guardar en historial — header + body + opciones de todas las secciones
    const opciones = sections.flatMap(s =>
      s.rows.map(r => `› ${r.title}${r.description ? ` — ${r.description}` : ""}`)
    ).join("\n");
    const textoGuardar = [
      header ? `*${header}*` : null,
      body,
      opciones,
    ].filter(Boolean).join("\n");
    await axios.post(
      `${API_BASE}/api/chat/bot-message`,
      { phone: to, texto: textoGuardar },
      { headers: await apiHeaders(), timeout: 3000 }
    ).catch(() => {});
  } catch (e) {
    console.error("❌ sendList:", e.response?.data || e.message);
  }
}

/* ============================================================
   SECCIÓN 2 · LLAMADAS AL BACKEND INTERNO
   ============================================================ */

const apiHeaders = async () => ({
  Authorization:  `Bearer ${await getBotToken()}`,
  "Content-Type": "application/json",
});

// Consulta los slots disponibles para UNA fecha exacta (YYYY-MM-DD)
async function obtenerSlotsParaFecha(sedeSlug, especialidad, fechaStr) {
  const { data } = await axios.get(`${API_BASE}/api/calendar/slots`, {
    params:  { fecha: fechaStr, especialidad, sede: sedeSlug },
    headers: await apiHeaders(),
    timeout: API_TIMEOUT,
  });
  return data.slots || [];
}

/**
 * Busca los próximos días hábiles con disponibilidad.
 *
 * Algoritmo:
 *  1. Genera hasta 60 días hábiles (L–V) partiendo de mañana en Colombia
 *  2. Los consulta en lotes de 10 en paralelo (rápido)
 *  3. Devuelve los primeros `maxDias` que tengan al menos 1 slot libre
 *  4. Si los primeros 10 están llenos, automáticamente prueba el 11, 12...
 *
 * @param {string}  sedeSlug
 * @param {string}  especialidad
 * @param {number}  [maxDias=10]   — días con disponibilidad a devolver
 * @returns {Array<{fechaStr, label, slots}>}
 */
async function obtenerDiasDisponibles(sedeSlug, especialidad, maxDias = 10) {
  // Fecha de hoy en Colombia usando aritmética UTC pura (sin locale)
  const hoyStr = fechaColombiaStr(new Date());

  // Medianoche Colombia = 05:00 UTC (UTC-5)
  const [hy, hm, hd] = hoyStr.split("-").map(Number);
  const hoyUTC = Date.UTC(hy, hm - 1, hd, 5, 0, 0); // 00:00 Colombia en UTC

  // Generar candidatos: días hábiles (L-V) a partir de mañana
  // Máximo 60 candidatos para no tardar demasiado (2-3 meses laborales)
  const candidatos = [];
  for (let i = 1; candidatos.length < 60; i++) {
    const cursorUTC = hoyUTC + i * 24 * 60 * 60 * 1000;
    const cursor    = new Date(cursorUTC);
    const dow       = cursor.getUTCDay(); // getUTCDay porque el objeto es UTC
    if (dow === 0 || dow === 6) continue; // saltar sábado y domingo
    candidatos.push(toYMD(cursor));       // "YYYY-MM-DD" sin depender de locale
  }

  const resultado = [];

  // Consultar en lotes de 5 en paralelo (equilibrio entre velocidad y carga)
  const LOTE = 5;
  for (let i = 0; i < candidatos.length && resultado.length < maxDias; i += LOTE) {
    const lote = candidatos.slice(i, i + LOTE);
    const respuestas = await Promise.all(
      lote.map(async fechaStr => {
        try {
          const slots = await obtenerSlotsParaFecha(sedeSlug, especialidad, fechaStr);
          return { fechaStr, slots };
        } catch (err) {
          console.warn(`⚠️ Slots ${fechaStr}:`, err.response?.data || err.message);
          return { fechaStr, slots: [] };
        }
      })
    );
    for (const { fechaStr, slots } of respuestas) {
      if (slots.length > 0 && resultado.length < maxDias) {
        resultado.push({ fechaStr, label: labelFecha(fechaStr), slots });
      }
    }
  }

  return resultado;
}

async function crearCita(pacienteId, sedeSlug, especialidad, slot) {
  const { data } = await axios.post(
    `${API_BASE}/api/calendar/appointments`,
    { pacienteId, sedeSlug, especialidad, fechaInicio: slot.inicio, fechaFin: slot.fin },
    { headers: await apiHeaders(), timeout: API_TIMEOUT }
  );
  return data.cita;
}

async function obtenerPaciente(phone) {
  try {
    const { data } = await axios.get(`${API_BASE}/api/patients/by-phone/${phone}`, {
      headers: await apiHeaders(),
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
      headers: await apiHeaders(),
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
    { headers: await apiHeaders(), timeout: API_TIMEOUT }
  );
}

/**
 * Llama al endpoint de procesamiento de documentos.
 * Incluye verificación de calidad IA automática.
 * Devuelve { legible, logId, datos, confianza } o { legible: false, problema }
 */
async function procesarDocAPI(phone, mediaId) {
  const paciente = await obtenerPaciente(phone);
  const { data } = await axios.post(
    `${API_BASE}/api/process-document`,
    { mediaId, pacienteId: paciente?.id || null },
    { headers: await apiHeaders(), timeout: 35000 } // Gemini puede tardar hasta 30s
  );
  return data;
}

/**
 * Actualiza el perfil del paciente con los datos extraídos del documento.
 */
async function actualizarPacienteAPI(pacienteId, datos) {
  if (!pacienteId || !datos || !Object.keys(datos).length) return;
  try {
    await axios.patch(
      `${API_BASE}/api/patients/${pacienteId}`,
      datos,
      { headers: await apiHeaders(), timeout: API_TIMEOUT }
    );
  } catch (e) {
    console.warn("⚠️ actualizarPacienteAPI:", e.message);
  }
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

// ══════════════════════════════════════════════════════════════
// UTILIDADES DE FECHA — Colombia (UTC-5)
// IMPORTANTE: Railway corre en UTC. Nunca usamos toLocaleDateString
// sin timeZone explícito porque el resultado depende del locale del SO
// y puede ser incorrecto en entornos con ICU mínimo.
// ══════════════════════════════════════════════════════════════

function fmtFecha(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtHora(iso) {
  return new Date(iso).toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Devuelve "YYYY-MM-DD" en zona horaria Colombia (UTC-5).
 * Usa aritmética UTC pura — sin depender de locale ni toLocaleDateString.
 * Ejemplo: si son las 23:30 UTC del 27, en Colombia son las 18:30 del 27 → "2026-04-27"
 */
function fechaColombiaStr(date) {
  const COL_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC-5
  const col = new Date(date.getTime() - COL_OFFSET_MS);
  return col.toISOString().slice(0, 10); // siempre YYYY-MM-DD
}

/**
 * Crea un objeto Date que representa medianoche local Colombia para fechaStr.
 * fechaStr: "YYYY-MM-DD"
 */
function parseFechaStr(fechaStr) {
  const [y, m, d] = fechaStr.split("-").map(Number);
  // Medianoche Colombia = 05:00 UTC (UTC-5)
  return new Date(Date.UTC(y, m - 1, d, 5, 0, 0));
}

/**
 * Formatea una fecha YYYY-MM-DD como texto legible en español.
 * Usa el objeto Date directamente para evitar locale de SO.
 * Resultado: "lunes 27 abr."
 */
function labelFecha(fechaStr) {
  const date = parseFechaStr(fechaStr);
  const dias  = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const meses = ["ene.","feb.","mar.","abr.","may.","jun.",
                 "jul.","ago.","sep.","oct.","nov.","dic."];
  // getUTC* porque parseFechaStr usa UTC
  const dow = date.getUTCDay();
  const d   = date.getUTCDate();
  const mo  = date.getUTCMonth();
  return `${dias[dow]} ${d} ${meses[mo]}`;
}

/**
 * Etiqueta larga para confirmaciones: "lunes 27 de abril de 2026"
 */
function labelFechaLarga(fechaStr) {
  const date = parseFechaStr(fechaStr);
  const dias  = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const meses = ["enero","febrero","marzo","abril","mayo","junio",
                 "julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const dow = date.getUTCDay();
  const d   = date.getUTCDate();
  const mo  = date.getUTCMonth();
  const y   = date.getUTCFullYear();
  return `${dias[dow]} ${d} de ${meses[mo]} de ${y}`;
}

/**
 * Construye "YYYY-MM-DD" de forma segura sin depender de locale.
 */
function toYMD(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
   SECCIÓN 6 · FLUJO DE FECHAS Y SLOTS
   ============================================================ */

/**
 * PASO 1: Muestra los próximos 10 días hábiles con disponibilidad.
 * El paciente elige primero el DÍA, luego el horario específico.
 * Si los 10 primeros días están llenos, muestra el 11, 12, etc.
 */
async function enviarFechas(to, sedeNombre, especialidad) {
  await sendText(to, `🔍 Buscando disponibilidad en *${sedeNombre}*... ⏳`);

  let dias;
  try {
    dias = await obtenerDiasDisponibles(SEDE_SLUG[sedeNombre], especialidad, 10);
  } catch (err) {
    console.error("❌ Error obteniendo días:", err.message);
    const esTimeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";
    await sendText(to, esTimeout
      ? "⏱️ El servidor tardó demasiado. Intenta en unos segundos."
      : "⚠️ No pudimos consultar la disponibilidad. Intenta en unos minutos."
    );
    return false;
  }

  if (!dias.length) {
    await sendText(to,
      `😔 No hay disponibilidad próxima en *${sedeNombre}*.
¿Deseas consultar en otra sede?`
    );
    await menuSedesCita(to);
    return false;
  }

  // Guardar la lista completa de días+slots en Redis (TTL 15 min)
  await saveSlotSelection(to, dias);

  await sendList(to, {
    header:      `📅 ${sedeNombre} — Días disponibles`,
    body:        `Selecciona el día para tu cita de *${especialidad}*:`,
    footer:      "Días hábiles con horarios libres",
    buttonLabel: "Ver días",
    sections: [{
      title: "Días disponibles",
      rows:  dias.map((d, i) => ({
        id:          `fecha_${i}`,
        title:       d.label.slice(0, 24),
        description: `${d.slots.length} horario${d.slots.length !== 1 ? "s" : ""} disponible${d.slots.length !== 1 ? "s" : ""}`,
      })),
    }],
  });

  return true;
}

/**
 * PASO 2: Muestra los horarios disponibles para el día elegido.
 * @param {string} fechaStr  — YYYY-MM-DD del día seleccionado
 * @param {Array}  slots     — lista de slots ya consultada (sin nueva llamada a la API)
 */
async function enviarSlotsParaDia(to, sedeNombre, especialidad, fechaStr, slots) {
  // Reemplazar en Redis con solo los slots de este día (TTL 15 min)
  await saveSlotSelection(to, slots);

  const labelDia = labelFechaLarga(fechaStr);

  await sendList(to, {
    header:      `🕐 ${labelDia}`,
    body:        `Selecciona el horario para *${especialidad}* en ${sedeNombre}:`,
    footer:      "Horarios en tiempo real",
    buttonLabel: "Ver horarios",
    sections: [{
      title: "Horarios disponibles",
      rows:  slots.map((s, i) => {
        // El label tiene formato "lunes 27 abr. — 11:00"
        // Extraemos solo la hora para el título
        const hora = s.label.split(" — ")[1] || s.label.slice(-5);
        return {
          id:          `slot_${i}`,
          title:       hora,
          description: `${sedeNombre} · ${especialidad}`.slice(0, 72),
        };
      }),
    }],
  });
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

async function handleBot(from, text, buttonId, mediaId) {
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
      await saveSession(from, { paso: "cita_doc_cedula", datos: { ...sesion.datos, eps: EPS[payload] } });
      await sendText(from,
        `✅ EPS: *${EPS[payload]}*\n\n` +
        `📋 Para verificar tu identidad, envía una foto clara de:\n` +
        `📷 Tu *cédula de ciudadanía* (CC) o *tarjeta de identidad* (TI)\n\n` +
        `_Solo el frente. Buena luz, sin borrosa, todo visible._`
      );
    } else {
      await sendText(from, "Por favor selecciona tu EPS de la lista 👆");
      await menuEPS(from, sesion.datos.especialidad);
    }
    return;
  }

  // ── Paso 1 de documentos: Cédula / Tarjeta de Identidad ─────
  if (sesion.paso === "cita_doc_cedula") {
    if (!mediaId) {
      await sendText(from,
        `📷 Por favor envía una foto de tu *cédula* (CC) o *tarjeta de identidad* (TI).\n` +
        `_Sin borrosidad, buena luz, todo el documento visible._`
      );
      return;
    }

    await sendText(from, "🔍 Verificando tu documento de identidad... ⏳");

    try {
      const resultado = await procesarDocAPI(from, mediaId);

      if (resultado.legible === false) {
        await sendText(from,
          `📷 No pudimos leer tu documento.\n\n` +
          `*Motivo:* _${resultado.problema || "Imagen poco clara."}_\n\n` +
          `Intenta de nuevo con:\n• Buena iluminación 💡\n• Sin movimiento\n` +
          `• Todo el documento visible\n• Sobre superficie oscura y plana`
        );
        return; // Queda en cita_doc_cedula
      }

      // Extraer datos de la cédula
      const datos   = resultado.datos || {};
      const nombre  = datos.nombre   || null;
      const docNum  = datos.cedula   || null;

      // Actualizar perfil del paciente con los datos extraídos
      const paciente = await obtenerPaciente(from);
      if (paciente) {
        const update = {};
        if (nombre) update.nombre    = nombre;
        if (docNum) update.documento = docNum;
        await actualizarPacienteAPI(paciente.id, update);
      }

      const msgConf = nombre && docNum
        ? `✅ *Identidad verificada*\n\n👤 *${nombre}*\n🪪 ${docNum}`
        : `✅ Documento de identidad recibido.`;

      await sendText(from,
        msgConf + `\n\n` +
        `Ahora envía la foto de tu *autorización EPS* 📄\n` +
        `_(El documento que tu EPS te entrega para autorizar la cita)_`
      );

      await saveSession(from, {
        paso:  "cita_doc_autorizacion",
        datos: {
          ...sesion.datos,
          nombre:       nombre   || sesion.datos.nombre   || "Paciente",
          documento:    docNum   || sesion.datos.documento || "",
          logIdCedula:  resultado.logId,
        },
      });

    } catch (err) {
      console.error("❌ procesarDocAPI cédula:", err.message);
      await sendText(from, "⚠️ Problema procesando el documento. Vuelve a enviarlo:");
    }
    return;
  }

  // ── Paso 2 de documentos: Autorización EPS ───────────────────
  if (sesion.paso === "cita_doc_autorizacion") {
    if (!mediaId) {
      await sendText(from,
        `📄 Envía la foto de tu *autorización EPS*\n` +
        `_(El papel que te da la EPS para ir a la cita)_`
      );
      return;
    }

    await sendText(from, "🔍 Procesando autorización... ⏳");

    try {
      const resultado = await procesarDocAPI(from, mediaId);

      if (resultado.legible === false) {
        await sendText(from,
          `📷 No pudimos leer la autorización.\n\n` +
          `*Motivo:* _${resultado.problema || "Imagen poco clara."}_\n\n` +
          `Por favor vuelve a enviarla con buena iluminación.`
        );
        return;
      }

      await sendText(from,
        `✅ Autorización recibida.\n\n` +
        `Por último, envía tu *historia clínica* 📋\n` +
        `_(Si no la tienes disponible, escribe *"omitir"*)_`
      );

      await saveSession(from, {
        paso:  "cita_doc_historial",
        datos: { ...sesion.datos, logIdAutorizacion: resultado.logId },
      });

    } catch (err) {
      console.error("❌ procesarDocAPI autorizacion:", err.message);
      await sendText(from, "⚠️ Problema procesando la autorización. Vuelve a enviarla:");
    }
    return;
  }

  // ── Paso 3 de documentos: Historia clínica (opcional) ────────
  if (sesion.paso === "cita_doc_historial") {
    const omitir = ["omitir", "no tengo", "skip", "no"].includes(msg);

    if (!mediaId && !omitir) {
      await sendText(from,
        `📋 Envía tu *historia clínica* o escribe *"omitir"* si no la tienes disponible.`
      );
      return;
    }

    let logIdHistorial = null;

    if (mediaId) {
      await sendText(from, "🔍 Procesando historia clínica... ⏳");
      try {
        const resultado = await procesarDocAPI(from, mediaId);
        if (resultado.legible === false) {
          await sendText(from,
            `📷 No pudimos leer la historia clínica.\n\n` +
            `*Motivo:* _${resultado.problema || "Imagen poco clara."}_\n\n` +
            `Vuelve a enviarla o escribe *"omitir"* para continuar.`
          );
          return;
        }
        logIdHistorial = resultado.logId;
        await sendText(from, `✅ Historia clínica recibida.`);
      } catch (err) {
        console.error("❌ procesarDocAPI historial:", err.message);
        // Si falla el procesamiento, continuar de todos modos
      }
    }

    const nombre = sesion.datos.nombre || "Paciente";
    await saveSession(from, {
      paso:  "cita_sede",
      datos: { ...sesion.datos, logIdHistorial },
    });
    await sendText(from, `Gracias, *${nombre}*. 😊\n\nSelecciona la sede para tu cita:`);
    await menuSedesCita(from);
    return;
  }

  // ── Sede de la cita ────────────────────────────────────────
  if (sesion.paso === "cita_sede") {
    if (SEDES_MAP[payload]) {
      const sede = SEDES_MAP[payload];
      // Ir a selección de FECHA (nuevo paso intermedio)
      await saveSession(from, { paso: "cita_fecha", datos: { ...sesion.datos, sede } });
      await enviarFechas(from, sede, sesion.datos.especialidad);
    } else {
      await sendText(from, "Por favor selecciona una sede de la lista 👆");
      await menuSedesCita(from);
    }
    return;
  }

  // ── Selección de fecha (día) ───────────────────────────────
  if (sesion.paso === "cita_fecha") {
    // Cambio de sede desde la pantalla de fechas
    if (SEDES_MAP[payload]) {
      const nuevaSede = SEDES_MAP[payload];
      await saveSession(from, { ...sesion, datos: { ...sesion.datos, sede: nuevaSede } });
      await enviarFechas(from, nuevaSede, sesion.datos.especialidad);
      return;
    }

    const fechaMatch = payload.match(/^fecha_(\d+)$/);
    if (!fechaMatch) {
      await sendText(from, "Por favor selecciona un día de la lista 👆");
      await enviarFechas(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    // Recuperar la lista de días guardada en Redis
    const dias = await getSlotSelection(from);
    if (!dias || !Array.isArray(dias) || !dias[0]?.fechaStr) {
      // Los datos expiraron (TTL 15 min), volver a buscar
      await sendText(from, "⏱️ La consulta expiró. Buscando disponibilidad de nuevo...");
      await enviarFechas(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    const diaElegido = dias[parseInt(fechaMatch[1])];
    if (!diaElegido) {
      await sendText(from, "⚠️ Ese día ya no está disponible. Selecciona otro:");
      await enviarFechas(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    // Guardar fecha elegida en sesión y pasar a selección de hora
    await saveSession(from, {
      paso:  "cita_slot",
      datos: { ...sesion.datos, fechaStr: diaElegido.fechaStr },
    });
    await enviarSlotsParaDia(
      from,
      sesion.datos.sede,
      sesion.datos.especialidad,
      diaElegido.fechaStr,
      diaElegido.slots
    );
    return;
  }

  // ── Selección de slot (hora dentro del día elegido) ──────────
  if (sesion.paso === "cita_slot") {
    // Cambio de sede → volver a elegir fecha
    if (SEDES_MAP[payload]) {
      const nuevaSede = SEDES_MAP[payload];
      await saveSession(from, { paso: "cita_fecha", datos: { ...sesion.datos, sede: nuevaSede, fechaStr: undefined } });
      await enviarFechas(from, nuevaSede, sesion.datos.especialidad);
      return;
    }

    const slotMatch = payload.match(/^slot_(\d+)$/);
    if (!slotMatch) {
      await sendText(from, "Por favor selecciona un horario de la lista 👆");
      // Volver a mostrar los slots del día guardado
      const slotsActuales = await getSlotSelection(from);
      if (slotsActuales && sesion.datos.fechaStr) {
        await enviarSlotsParaDia(from, sesion.datos.sede, sesion.datos.especialidad, sesion.datos.fechaStr, slotsActuales);
      } else {
        await saveSession(from, { paso: "cita_fecha", datos: { ...sesion.datos, fechaStr: undefined } });
        await enviarFechas(from, sesion.datos.sede, sesion.datos.especialidad);
      }
      return;
    }

    const slots = await getSlotSelection(from);
    // Si expiró, o si los datos de Redis son la lista de días (no slots),
    // volver al paso de selección de fecha
    if (!slots || !Array.isArray(slots) || slots.length === 0 || slots[0]?.fechaStr) {
      await sendText(from, "⏱️ Los horarios expiraron. Selecciona el día de nuevo:");
      await saveSession(from, { paso: "cita_fecha", datos: { ...sesion.datos, fechaStr: undefined } });
      await enviarFechas(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    const slot = slots[parseInt(slotMatch[1])];
    if (!slot) {
      await sendText(from, "⚠️ Ese horario ya no está disponible. Selecciona otro:");
      await enviarSlotsParaDia(from, sesion.datos.sede, sesion.datos.especialidad, sesion.datos.fechaStr, slots);
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

      // Mostrar la hora correcta en Colombia usando el label del slot
      // slot.label tiene el formato "lunes 27 abr. — 11:00"
      const horaSlot = slot.label.split(" — ")[1] || fmtHora(slot.inicio);
      const diaSlot  = sesion.datos.fechaStr
        ? labelFechaLarga(sesion.datos.fechaStr)
        : slot.label.split(" — ")[0];

      await sendText(from,
        `🎉 *¡Cita registrada exitosamente!*\n\n` +
        `👤 ${sesion.datos.nombre}\n` +
        `🪪 ${sesion.datos.documento}\n` +
        `🏥 ${sesion.datos.especialidad} · ${sesion.datos.eps}\n` +
        `📅 ${diaSlot} a las *${horaSlot}*\n` +
        `📍 ${sesion.datos.sede}\n` +
        `🆔 Ref: \`${cita.id.slice(-8).toUpperCase()}\`\n\n` +
        `⏳ Tu solicitud está *pendiente de aprobación*.\n` +
        `Recibirás un mensaje cuando sea confirmada o denegada.`
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

    // Notificar al panel que este paciente solicita asesor
    await axios.post(
      `${API_BASE}/api/chat/request-asesor`,
      { phone: from, motivo },
      { headers: await apiHeaders(), timeout: 3000 }
    ).catch(() => {});
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
