// prisma/seed.js
// ============================================================
//  Seed v3 — IPS Salud Vida
//  Sedes reales con bloques mañana + tarde correctos.
//  Requiere: migration_multiple_blocks.sql aplicada primero.
// ============================================================

"use strict";

const { PrismaClient } = require("@prisma/client");
const bcrypt           = require("bcrypt");

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Iniciando seed v3...\n");

  const hash  = await bcrypt.hash(process.env.ADMIN_PASSWORD || "Admin123!", 12);
  const admin = await prisma.usuario.upsert({
    where:  { email: "admin@ipssaludvida.com" },
    update: {},
    create: { nombre: "Administrador", email: "admin@ipssaludvida.com", passwordHash: hash, rol: "ADMIN" },
  });
  console.log("✅ Admin:", admin.email);

  const sedes = [
    { slug: "sede-monteria",   nombre: "Montería",       direccion: "Dirección — actualizar", telefono: "PENDIENTE" },
    { slug: "sede-tierralta",  nombre: "Tierralta",      direccion: "Dirección — actualizar", telefono: "PENDIENTE" },
    { slug: "sede-cdo",        nombre: "Ciénaga de Oro", direccion: "Dirección — actualizar", telefono: "PENDIENTE" },
    { slug: "sede-cerete",     nombre: "Cereté",         direccion: "Dirección — actualizar", telefono: "PENDIENTE" },
    { slug: "sede-san-carlos", nombre: "San Carlos",     direccion: "Dirección — actualizar", telefono: "PENDIENTE" },
    { slug: "sede-valencia",   nombre: "Valencia",       direccion: "Dirección — actualizar", telefono: "PENDIENTE" },
  ];

  for (const sedeData of sedes) {
    const sede = await prisma.sede.upsert({
      where:  { slug: sedeData.slug },
      update: {},
      create: sedeData,
    });
    await prisma.horarioSede.deleteMany({ where: { sedeId: sede.id } });
    const bloques = getBloques(sedeData.slug);
    for (const b of bloques) {
      await prisma.horarioSede.create({ data: { sedeId: sede.id, ...b } });
    }
    console.log(`✅ ${sedeData.nombre} — ${bloques.length} bloques`);
  }

  const slugsReales = sedes.map(s => s.slug);
  const sedesViejas = await prisma.sede.findMany({ where: { slug: { notIn: slugsReales } } });
  for (const sv of sedesViejas) {
    await prisma.sede.update({ where: { id: sv.id }, data: { activa: false } });
    console.log(`⚠️  Desactivada: ${sv.nombre}`);
  }

  console.log("\n✅ Seed v3 completado.");
  console.log("⚠️  Actualiza direcciones y teléfonos de cada sede.\n");
}

function getBloques(slug) {
  switch (slug) {

    case "sede-monteria": {
      // Médico: ANDREA/MARIA — Lun-Vie mañana + tarde
      const b = [];
      for (const dia of [1,2,3,4,5]) {
        b.push({ diaSemana: dia, apertura: "11:00", cierre: "11:40", duracionSlot: 10 });
        b.push({ diaSemana: dia, apertura: "17:00", cierre: "17:40", duracionSlot: 10 });
      }
      return b;
    }

    case "sede-tierralta":
      // Médico: ISABEL VILLADIEGO
      // Lun/Mié/Vie: tarde | Mar/Jue: mañana + tarde
      return [
        { diaSemana: 1, apertura: "16:40", cierre: "17:20", duracionSlot: 10 },
        { diaSemana: 2, apertura: "11:00", cierre: "11:40", duracionSlot: 10 },
        { diaSemana: 2, apertura: "16:40", cierre: "17:20", duracionSlot: 10 },
        { diaSemana: 3, apertura: "16:40", cierre: "17:20", duracionSlot: 10 },
        { diaSemana: 4, apertura: "11:00", cierre: "11:40", duracionSlot: 10 },
        { diaSemana: 4, apertura: "16:40", cierre: "17:20", duracionSlot: 10 },
        { diaSemana: 5, apertura: "16:40", cierre: "17:20", duracionSlot: 10 },
      ];

    case "sede-cdo": {
      // Médico: Cenobia — Lun-Vie mañana + tarde
      const b = [];
      for (const dia of [1,2,3,4,5]) {
        b.push({ diaSemana: dia, apertura: "11:00", cierre: "11:30", duracionSlot: 10 });
        b.push({ diaSemana: dia, apertura: "16:50", cierre: "17:10", duracionSlot: 10 });
      }
      return b;
    }

    case "sede-cerete":
      // Médico: YESICA CONTRERAS MORILLO
      // Lun/Mié/Vie mañana + todos tarde (60min)
      return [
        { diaSemana: 1, apertura: "11:00", cierre: "11:40", duracionSlot: 10 },
        { diaSemana: 1, apertura: "13:30", cierre: "16:30", duracionSlot: 60 },
        { diaSemana: 2, apertura: "13:30", cierre: "16:30", duracionSlot: 60 },
        { diaSemana: 3, apertura: "11:00", cierre: "11:40", duracionSlot: 10 },
        { diaSemana: 3, apertura: "13:30", cierre: "16:30", duracionSlot: 60 },
        { diaSemana: 4, apertura: "13:30", cierre: "16:30", duracionSlot: 60 },
        { diaSemana: 5, apertura: "11:00", cierre: "11:40", duracionSlot: 10 },
        { diaSemana: 5, apertura: "13:30", cierre: "16:30", duracionSlot: 60 },
      ];

    case "sede-san-carlos":
      // Médico: YESICA CONTRERAS — Solo Mar/Jue 07:40–10:00
      return [
        { diaSemana: 2, apertura: "07:40", cierre: "10:50", duracionSlot: 50 },
        { diaSemana: 4, apertura: "07:40", cierre: "10:50", duracionSlot: 50 },
      ];

    case "sede-valencia":
      // Médico: ISABEL VILLADIEGO — Solo Lun/Mié/Vie 10:40–11:00
      return [
        { diaSemana: 1, apertura: "10:40", cierre: "11:10", duracionSlot: 10 },
        { diaSemana: 3, apertura: "10:40", cierre: "11:10", duracionSlot: 10 },
        { diaSemana: 5, apertura: "10:40", cierre: "11:10", duracionSlot: 10 },
      ];

    default:
      return [];
  }
}

main()
  .catch(e => { console.error("❌ Error en seed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
