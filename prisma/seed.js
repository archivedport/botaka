// prisma/seed.js
// ============================================================
//  Seed inicial: sedes, horarios y usuario admin.
//  Ejecutar con: npx prisma db seed
// ============================================================

"use strict";

const { PrismaClient } = require("@prisma/client");
const bcrypt           = require("bcrypt");

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Iniciando seed...");

  // ── Usuario Admin ────────────────────────────────────────
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || "Admin123!", 12);
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
  console.log("✅ Admin creado:", admin.email);

  // ── Sedes ────────────────────────────────────────────────
  const sedes = [
    { slug: "sede-centro", nombre: "Sede Centro", direccion: "Calle 10 #5-32, Piso 2",  telefono: "(604) 321-0000" },
    { slug: "sede-norte",  nombre: "Sede Norte",  direccion: "Carrera 45 #80-15",       telefono: "(604) 321-0001" },
    { slug: "sede-sur",    nombre: "Sede Sur",    direccion: "Avenida 30 #12-40",       telefono: "(604) 321-0002" },
  ];

  for (const sedeData of sedes) {
    const sede = await prisma.sede.upsert({
      where:  { slug: sedeData.slug },
      update: {},
      create: sedeData,
    });

    // Horarios: Lunes (1) a Viernes (5) 7–18, Sábado (6) 8–13
    const horarios = [
      { diaSemana: 1, apertura: "07:00", cierre: "18:00", duracionSlot: 30 },
      { diaSemana: 2, apertura: "07:00", cierre: "18:00", duracionSlot: 30 },
      { diaSemana: 3, apertura: "07:00", cierre: "18:00", duracionSlot: 30 },
      { diaSemana: 4, apertura: "07:00", cierre: "18:00", duracionSlot: 30 },
      { diaSemana: 5, apertura: "07:00", cierre: "18:00", duracionSlot: 30 },
      { diaSemana: 6, apertura: "08:00", cierre: "13:00", duracionSlot: 30 },
    ];

    for (const h of horarios) {
      await prisma.horarioSede.upsert({
        where:  { sedeId_diaSemana: { sedeId: sede.id, diaSemana: h.diaSemana } },
        update: {},
        create: { sedeId: sede.id, ...h },
      });
    }
    console.log(`✅ Sede creada: ${sedeData.nombre}`);
  }

  console.log("\n✅ Seed completado exitosamente.");
}

main()
  .catch(e => { console.error("❌ Error en seed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
