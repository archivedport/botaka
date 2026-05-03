// src/modules/patients/patients.controller.js
// ============================================================
//  GET    /api/patients           — listar con búsqueda
//  GET    /api/patients/:id       — detalle
//  GET    /api/patients/by-phone/:phone
//  PATCH  /api/patients/:id       — actualizar datos
// ============================================================

"use strict";

const prisma   = require("../../config/database");
const auditSvc = require("../audit/audit.service");

// GET /api/patients?q=nombre&page=1&limit=20
async function list(req, res) {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    const where = {};

    if (q) {
      where.OR = [
        { nombre:    { contains: q, mode: "insensitive" } },
        { documento: { contains: q } },
        { phone:     { contains: q } },
        { eps:       { contains: q, mode: "insensitive" } },
      ];
    }

    const [total, pacientes] = await Promise.all([
      prisma.paciente.count({ where }),
      prisma.paciente.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip:    (parseInt(page) - 1) * parseInt(limit),
        take:    parseInt(limit),
        select: {
          id: true, phone: true, nombre: true, documento: true,
          eps: true, sede: true, createdAt: true,
          _count: { select: { citas: true } },
        },
      }),
    ]);

    return res.json({ total, page: parseInt(page), limit: parseInt(limit), pacientes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/patients/:id
async function getById(req, res) {
  try {
    const paciente = await prisma.paciente.findUnique({
      where:   { id: req.params.id },
      include: {
        citas: {
          orderBy: { fechaInicio: "desc" },
          take:    10,
          include: { sede: { select: { nombre: true } } },
        },
        logsIA: {
          orderBy: { createdAt: "desc" },
          take:    10,
          select:  {
            id: true, tipoDocumento: true, confianza: true,
            createdAt: true, validadoEn: true,
            resultadoRaw: true,  // contiene cloudinaryUrl
          },
        },
      },
    });

    if (!paciente) return res.status(404).json({ error: "Paciente no encontrado." });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "VER_HISTORIA",
      entidadTipo: "Paciente",
      entidadId:   paciente.id,
      req,
    });

    return res.json({ paciente });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/patients/by-phone/:phone
async function getByPhone(req, res) {
  try {
    const paciente = await prisma.paciente.findUnique({
      where: { phone: req.params.phone },
    });
    if (!paciente) return res.status(404).json({ error: "Paciente no encontrado." });
    return res.json({ paciente });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// PATCH /api/patients/:id
async function update(req, res) {
  try {
    const CAMPOS_PERMITIDOS = [
      "nombre", "documento", "tipoDocumento", "fechaNacimiento",
      "email", "celular", "eps", "vigenciaEPS", "sede",
    ];

    const data = {};
    for (const campo of CAMPOS_PERMITIDOS) {
      if (req.body[campo] !== undefined) data[campo] = req.body[campo];
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: "No hay campos para actualizar." });
    }

    // Convertir fechas si vienen como string
    if (data.fechaNacimiento) data.fechaNacimiento = new Date(data.fechaNacimiento);
    if (data.vigenciaEPS)     data.vigenciaEPS     = new Date(data.vigenciaEPS);

    const paciente = await prisma.paciente.update({
      where: { id: req.params.id },
      data,
    });

    await auditSvc.registrar({
      usuarioId:   req.usuario.id,
      accion:      "EDITAR_PACIENTE",
      entidadTipo: "Paciente",
      entidadId:   paciente.id,
      detalle:     { camposActualizados: Object.keys(data) },
      req,
    });

    return res.json({ paciente });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { list, getById, getByPhone, update };
