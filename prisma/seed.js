// prisma/seed.js
// ============================================================
//  Seed v2 — IPS Salud Vida
//  Sedes reales: Montería, Tierralta, Ciénaga de Oro,
//                Cereté, San Carlos, Valencia
//
//  NOTA IMPORTANTE: HorarioSede admite UN bloque por día.
//  Sedes con mañana + tarde están marcadas con (*) y usan
//  el bloque principal. El bloque secundario requiere un
//  ajuste de schema (ver comentario al final).
// ============================================================

"use strict";

const { PrismaClient } = require("@prisma/client");
const bcrypt           = require("bcrypt");

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Iniciando seed v2...\n");

  // ── Usuario Admin ────────────────────────────────────────
  const hash  = await bcrypt.hash(process.env.ADMIN_PASSWORD || "Admin123!", 12);
  const admin = await prisma.usuario.upsert({
    where:  { email: "admin@ipssaludvida.com" },
    update: {},
    create: {
      nombre:       "Administrador",
      email:        "admin@ipssaludvida.com",
      passwordHash: hash,
      rol:          "ADMIN",
    },
  });
  console.log("✅ Admin:", admin.email);

  // ── Sedes ────────────────────────────────────────────────
  // NOTA: actualiza direccion y telefono con los datos reales.
  const sedes = [
    {
      slug:      "sede-monteria",
      nombre:    "Montería",
      direccion: "Cl. 24 #15-35",
      telefono:  "3244226680",
    },
    {
      slug:      "sede-tierralta",
      nombre:    "Tierralta",
      direccion: "(GESTAR SALUD)",
      telefono:  "3244226680",
    },
    {
      slug:      "sede-cdo",
      nombre:    "Ciénaga de Oro",
      direccion: "(GESTAR SALUD)",
      telefono:  "3244226680",
    },
    {
      slug:      "sede-cerete",
      nombre:    "Cereté",
      direccion: "Calle 13A Cra 15-45 B/La Ceiba Orilla del Río (GESTAR SALUD)",
      telefono:  "3244226680",
    },
    {
      slug:      "sede-san-carlos",
      nombre:    "San Carlos",
      direccion: "(GESTAR SALUD)",
      telefono:  "3244226680",
    },
    {
      slug:      "sede-valencia",
      nombre:    "Valencia",
      direccion: "(GESTAR SALUD)",
      telefono:  "3244226680",
    },
  ];

  for (const sedeData of sedes) {
    const sede = await prisma.sede.upsert({
      where:  { slug: sedeData.slug },
      update: {},
      create: sedeData,
    });

    const horarios = getHorarios(sedeData.slug);

    for (const h of horarios) {
      await prisma.horarioSede.upsert({
        where:  { sedeId_diaSemana: { sedeId: sede.id, diaSemana: h.diaSemana } },
        update: { apertura: h.apertura, cierre: h.cierre, duracionSlot: h.duracionSlot },
        create: { sedeId: sede.id, ...h },
      });
    }
    console.log(`✅ ${sedeData.nombre} — ${horarios.length} horarios`);
  }

  // ── Desactivar sedes antiguas de prueba ──────────────────
  const slugsReales = sedes.map(s => s.slug);
  const sedesViejas = await prisma.sede.findMany({
    where: { slug: { notIn: slugsReales } },
  });
  for (const sv of sedesViejas) {
    await prisma.sede.update({ where: { id: sv.id }, data: { activa: false } });
    console.log(`⚠️  Sede antigua desactivada: ${sv.nombre} (${sv.slug})`);
  }

  console.log("\n✅ Seed v2 completado exitosamente.");
  console.log("⚠️  Recuerda actualizar las direcciones y teléfonos de cada sede.\n");
}

// ── Horarios por sede ─────────────────────────────────────
//
//  Fuente: HORARIO_DE_TODAS_LAS_SEDES.xlsx
//  Slots de 10 min salvo indicación.
//
//  diaSemana: 0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb
//
//  (*) = sede con dos bloques diarios (mañana + tarde).
//        La limitación actual de HorarioSede (1 bloque/día)
//        implica que solo se configura el bloque señalado.
//        Para habilitar ambos bloques se requiere ajuste de schema.

function getHorarios(slug) {
  switch (slug) {

    // ── Montería ──────────────────────────────────────────
    // Lun–Vie mañana: 11:00–11:30 (4 slots × 10 min) (*)
    // Lun–Vie tarde:  17:00–17:30 → pendiente schema split
    case "sede-monteria":
      return [1, 2, 3, 4, 5].map(dia => ({
        diaSemana:    dia,
        apertura:     "11:00",
        cierre:       "11:40",
        duracionSlot: 10,
      }));

    // ── Tierralta ─────────────────────────────────────────
    // Lun/Mié/Vie tarde: 16:40–17:10 (4 slots × 10 min)
    // Mar/Jue mañana:    11:00–11:30 (4 slots × 10 min) (*)
    // Mar/Jue tarde:     16:40–17:10 → pendiente schema split
    case "sede-tierralta":
      return [
        { diaSemana: 1, apertura: "16:40", cierre: "17:20", duracionSlot: 10 }, // Lunes tarde
        { diaSemana: 2, apertura: "11:00", cierre: "11:40", duracionSlot: 10 }, // Martes mañana (*)
        { diaSemana: 3, apertura: "16:40", cierre: "17:20", duracionSlot: 10 }, // Mié tarde
        { diaSemana: 4, apertura: "11:00", cierre: "11:40", duracionSlot: 10 }, // Jueves mañana (*)
        { diaSemana: 5, apertura: "16:40", cierre: "17:20", duracionSlot: 10 }, // Vie tarde
      ];

    // ── Ciénaga de Oro ────────────────────────────────────
    // Lun–Vie mañana: 11:00–11:20 (3 slots × 10 min) (*)
    // Lun–Vie tarde:  16:50–17:00 → pendiente schema split
    case "sede-cdo":
      return [1, 2, 3, 4, 5].map(dia => ({
        diaSemana:    dia,
        apertura:     "11:00",
        cierre:       "11:30",
        duracionSlot: 10,
      }));

    // ── Cereté ────────────────────────────────────────────
    // Lun/Mié/Vie mañana: 11:00–11:30 (4 slots × 10 min) (*)
    // Todos los días tarde: 13:30, 14:30, 15:30 (3 slots × 60 min)
    // → Lun/Mié/Vie usan mañana; Mar/Jue usan tarde
    case "sede-cerete":
      return [
        { diaSemana: 1, apertura: "11:00", cierre: "11:40", duracionSlot: 10  }, // Lunes mañana (*)
        { diaSemana: 2, apertura: "13:30", cierre: "16:30", duracionSlot: 60  }, // Martes tarde
        { diaSemana: 3, apertura: "11:00", cierre: "11:40", duracionSlot: 10  }, // Mié mañana (*)
        { diaSemana: 4, apertura: "13:30", cierre: "16:30", duracionSlot: 60  }, // Jueves tarde
        { diaSemana: 5, apertura: "11:00", cierre: "11:40", duracionSlot: 10  }, // Vie mañana (*)
      ];

    // ── San Carlos ────────────────────────────────────────
    // Solo Martes y Jueves: 07:40, 08:30, 09:20, 10:00
    // Intervalo predominante: 50 min (07:40 → 08:30 → 09:20)
    case "sede-san-carlos":
      return [
        { diaSemana: 2, apertura: "07:40", cierre: "10:10", duracionSlot: 50 }, // Martes
        { diaSemana: 4, apertura: "07:40", cierre: "10:10", duracionSlot: 50 }, // Jueves
      ];

    // ── Valencia ──────────────────────────────────────────
    // Solo Lunes, Miércoles, Viernes: 10:40, 10:50, 11:00
    case "sede-valencia":
      return [
        { diaSemana: 1, apertura: "10:40", cierre: "11:10", duracionSlot: 10 }, // Lunes
        { diaSemana: 3, apertura: "10:40", cierre: "11:10", duracionSlot: 10 }, // Miércoles
        { diaSemana: 5, apertura: "10:40", cierre: "11:10", duracionSlot: 10 }, // Viernes
      ];

    default:
      return [];
  }
}

main()
  .catch(e => { console.error("❌ Error en seed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());

// ============================================================
//  TODO — Schema split schedule (futuro)
// ============================================================
//  Para soportar mañana + tarde en el mismo día, se necesita
//  reemplazar el UNIQUE (sedeId, diaSemana) por una tabla
//  de bloques: HorarioBloque { sedeId, diaSemana, apertura, cierre, duracion }.
//
//  Sedes afectadas:
//    • Montería:       Lun–Vie tarde 17:00–17:30
//    • Tierralta:      Mar/Jue tarde 16:40–17:10
//    • Ciénaga de Oro: Lun–Vie tarde 16:50–17:00
//    • Cereté:         Lun/Mié/Vie tarde 13:30–15:30
// ============================================================
