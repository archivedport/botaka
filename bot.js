/**
 * ============================================================
 *  bot.js — IPS Salud Vida · WhatsApp Bot
 *
 *  Responsabilidad única: conversar con el paciente por
 *  WhatsApp y delegar toda la lógica de negocio al backend.
 *
 *  Lo que hace este archivo:
 *    • Gestionar el flujo de conversación (sesión en Redis)
 *    • Enviar mensajes y menús interactivos a Meta
 *    • Llamar al backend para slots y para crear citas
 *    • Ceder el control cuando el chat está en MANUAL
 *
 *  Lo que NO hace (lo maneja el backend):
 *    • Métricas y contadores de conversaciones
 *    • Lógica de asesores (cola, handoff, comandos #fin/#info)
 *    • Persistencia de citas en PostgreSQL
 *    • Procesamiento de documentos con IA
 *    • Instancia propia de Redis (usa la del backend)
 *
 *  Dependencias: axios  |  Variables requeridas: .env
 * ============================================================
 */

"use strict";

const axios = require("axios");

// ── Reutilizamos el cliente Redis y helpers del backend ───────
const {
  getSession,
  saveSession,
  clearSession,
  getChatStatus,
  getChatAsesor,
  saveSlotSelection,
  getSlotSelection,
  clearSlotSelection,
} = require("./src/config/redis");

// ── Configuración de Meta ─────────────────────────────────────
const { meta } = require("./src/config/env");

const WA_URL     = `${meta.baseUrl()}/${meta.phoneId}/messages`;
const WA_HEADERS = {
  Authorization:  `Bearer ${meta.token}`,
  "Content-Type": "application/json",
};

// ── URL del backend interno (mismo proceso en Railway) ────────
const API_BASE          = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const BOT_SERVICE_TOKEN = process.env.BOT_SERVICE_TOKEN || process.env.JWT_SECRET;

/* ============================================================
   SECCIÓN 1 · ENVÍO DE MENSAJES (Meta Cloud API)
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

const apiHeaders = () => ({ Authorization: `Bearer ${BOT_SERVICE_TOKEN}` });

/** Consulta slots disponibles al motor de calendario SQL. */
async function obtenerSlots(sedeSlug, especialidad) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + 1);
  const { data } = await axios.get(`${API_BASE}/api/calendar/slots`, {
    params:  { fecha: fecha.toISOString().slice(0, 10), especialidad, sede: sedeSlug },
    headers: apiHeaders(),
  });
  return data.slots || [];
}

/** Crea la cita en PostgreSQL con protección anti-colisión. */
async function crearCita(pacienteId, sedeSlug, especialidad, slot) {
  const { data } = await axios.post(
    `${API_BASE}/api/calendar/appointments`,
    { pacienteId, sedeSlug, especialidad, fechaInicio: slot.inicio, fechaFin: slot.fin },
    { headers: apiHeaders() }
  );
  return data.cita;
}

/** Busca el paciente por phone para obtener su ID de BD. */
async function obtenerPaciente(phone) {
  try {
    const { data } = await axios.get(`${API_BASE}/api/patients/by-phone/${phone}`, {
      headers: apiHeaders(),
    });
    return data.paciente;
  } catch {
    return null;
  }
}

/* ============================================================
   SECCIÓN 3 · MENÚS REUTILIZABLES
   ============================================================ */

async function menuPrincipal(to) {
  await sendButtons(to, {
    header:  "🏥 IPS Salud Vida",
    body:    "¡Bienvenido! ¿En qué podemos ayudarte hoy?",
    footer:  "Selecciona una opción",
    buttons: [
      { id: "menu_cita",     title: "📅 Agendar cita" },
      { id: "menu_horarios", title: "🕐 Horarios"      },
      { id: "menu_sedes",    title: "📍 Sedes"         },
    ],
  });
  await sendButtons(to, {
    body:    "¿Necesitas atención personalizada?",
    buttons: [{ id: "menu_asesor", title: "👨‍💼 Hablar con asesor" }],
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

/* ============================================================
   SECCIÓN 4 · MOSTRAR SLOTS (motor SQL del backend)
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
    await sendText(to, "⚠️ No pudimos consultar la disponibilidad. Intenta en unos minutos.");
    return false;
  }

  if (!slots.length) {
    await sendText(to, `😔 Sin disponibilidad en *${sedeNombre}* para los próximos días.\n¿Deseas consultar en otra sede?`);
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
      title:       s.label,
      description: sedeNombre,
    })) }],
  });

  return true;
}

/* ============================================================
   SECCIÓN 5 · HANDLER PRINCIPAL
   ============================================================ */

async function handleBot(from, text, buttonId) {
  const msg     = text?.trim().toLowerCase() || "";
  const payload = buttonId || msg;

  // Segunda defensa: si el chat está en MANUAL no procesar
  if (await getChatStatus(from) === "MANUAL") return;

  const sesion = await getSession(from);

  // ── Reinicio ───────────────────────────────────────────────
  if (["hola", "menu", "menú", "inicio", "start"].includes(msg) || payload === "menu_principal") {
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

    } else if (payload === "menu_horarios") {
      await sendText(from,
        `🕐 *Horarios de atención:*\n\n` +
        `🏢 *Sede Centro* — Lun–Vie 7–18 | Sáb 8–13\n` +
        `🏢 *Sede Norte*  — Lun–Vie 7–17 | Sáb 8–12\n` +
        `🏢 *Sede Sur*    — Lun–Vie 8–18 | Sáb 9–13\n\n` +
        `⚠️ Domingos y festivos: sin atención.\n📞 Urgencias: 018000-000000`
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
      await sendText(from, `👨‍💼 Con gusto te conectamos con un asesor.\n\n¿*Cuál es el motivo de tu consulta?*\n_(Escribe tu mensaje)_`);

    } else {
      await menuPrincipal(from);
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
      await sendText(from, "Por favor selecciona una especialidad 👆");
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
      await sendText(from, `✅ EPS: *${EPS[payload]}*\n\nEscribe tu *número de documento:*`);
    } else {
      await sendText(from, "Por favor selecciona tu EPS 👆");
      await menuEPS(from, sesion.datos.especialidad);
    }
    return;
  }

  // ── Documento ──────────────────────────────────────────────
  if (sesion.paso === "cita_documento") {
    const doc = text?.trim();
    if (doc && doc.length >= 6 && !isNaN(doc)) {
      await saveSession(from, { paso: "cita_nombre", datos: { ...sesion.datos, documento: doc } });
      await sendText(from, `✅ Documento recibido.\n\nEscribe tu *nombre completo:*`);
    } else {
      await sendText(from, "⚠️ Documento inválido (solo números, mínimo 6 dígitos).");
    }
    return;
  }

  // ── Nombre ─────────────────────────────────────────────────
  if (sesion.paso === "cita_nombre") {
    const nombre = text?.trim();
    if (nombre && nombre.length >= 3) {
      await saveSession(from, { paso: "cita_sede", datos: { ...sesion.datos, nombre } });
      await sendText(from, `Gracias, *${nombre}*. 😊\n\nSelecciona la sede para tu cita:`);
      await menuSedesCita(from);
    } else {
      await sendText(from, "⚠️ Escribe tu nombre completo (mínimo 3 caracteres).");
    }
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
      await sendText(from, "Por favor selecciona una sede 👆");
      await menuSedesCita(from);
    }
    return;
  }

  // ── Selección de slot ──────────────────────────────────────
  if (sesion.paso === "cita_slot") {
    // Permitir cambiar de sede desde esta pantalla
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
      await sendText(from, "⚠️ Los horarios expiraron. Volvemos a consultar...");
      await enviarSlots(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    const slot = slots[parseInt(slotMatch[1])];
    if (!slot) {
      await sendText(from, "Por favor selecciona un horario válido 👆");
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
        `🎉 *¡Cita registrada!*\n\n` +
        `👤 ${sesion.datos.nombre}\n` +
        `🪪 ${sesion.datos.documento}\n` +
        `🏥 ${sesion.datos.especialidad} | 🏦 ${sesion.datos.eps}\n` +
        `📅 ${slot.label}\n` +
        `📍 ${sesion.datos.sede}\n` +
        `🆔 Ref: \`${cita.id.slice(-8).toUpperCase()}\`\n\n` +
        `✅ Nos pondremos en contacto para confirmar.`
      );
    } catch (err) {
      const esColision = err.response?.status === 409;
      await sendText(from,
        esColision
          ? "⚠️ Ese horario acaba de ser reservado. Selecciona otro:"
          : "❌ No pudimos registrar tu cita. Intenta nuevamente."
      );
      await enviarSlots(from, sesion.datos.sede, sesion.datos.especialidad);
      return;
    }

    await clearSlotSelection(from);
    await saveSession(from, { paso: "menu", datos: {} });
    await sendButtons(from, {
      body:    "¿Deseas hacer algo más?",
      buttons: [
        { id: "menu_cita",      title: "📅 Nueva cita"    },
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
      await sendText(from, "Por favor cuéntanos el motivo de tu consulta. ✍️");
      return;
    }
    // El backend gestiona el handoff via PATCH /api/chat/toggle-status
    // El bot solo informa al paciente que quedó en espera
    await sendText(from,
      `⏳ *Conectando con un asesor...*\n\nMotivo: _${motivo}_\n\nUn asesor se comunicará contigo en breve. 🔔`
    );
    await saveSession(from, { paso: "con_asesor", datos: { motivo } });
    return;
  }

  // ── Fallback ───────────────────────────────────────────────
  await clearSession(from);
  await saveSession(from, { paso: "menu", datos: {} });
  await sendText(from, "😅 No entendí tu mensaje. Aquí tienes el menú principal:");
  await menuPrincipal(from);
}

/* ============================================================
   EXPORTACIONES  (consumidas por src/server.js)
   ============================================================ */
module.exports = { handleBot, sendText, sendButtons, menuPrincipal, saveSession };