// src/modules/auth/auth.controller.js
// ============================================================
//  Autenticación de asesores/admins.
//  POST /api/auth/login
//  POST /api/auth/refresh  (sin implementar aún — placeholder)
//  GET  /api/auth/me
// ============================================================

"use strict";

const bcrypt  = require("bcrypt");
const prisma  = require("../../config/database");
const { generarToken } = require("../../middleware/auth");

// POST /api/auth/login
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son obligatorios." });
    }

    const usuario = await prisma.usuario.findUnique({ where: { email } });
    if (!usuario || !usuario.activo) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    const ok = await bcrypt.compare(password, usuario.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    // Actualizar último acceso
    await prisma.usuario.update({
      where: { id: usuario.id },
      data:  { ultimoAcceso: new Date() },
    });

    const token = generarToken(usuario);

    return res.json({
      token,
      usuario: {
        id:     usuario.id,
        nombre: usuario.nombre,
        email:  usuario.email,
        rol:    usuario.rol,
      },
    });
  } catch (err) {
    console.error("Error en login:", err);
    return res.status(500).json({ error: "Error interno." });
  }
}

// GET /api/auth/me  (requiere token)
async function me(req, res) {
  return res.json({ usuario: req.usuario });
}

// POST /api/auth/change-password
async function changePassword(req, res) {
  try {
    const { passwordActual, passwordNuevo } = req.body;

    if (!passwordActual || !passwordNuevo) {
      return res.status(400).json({ error: "Ambas contraseñas son obligatorias." });
    }
    if (passwordNuevo.length < 8) {
      return res.status(400).json({ error: "La nueva contraseña debe tener al menos 8 caracteres." });
    }

    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
    const ok      = await bcrypt.compare(passwordActual, usuario.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Contraseña actual incorrecta." });
    }

    const { bcryptRounds } = require("../../config/env");
    const hash = await bcrypt.hash(passwordNuevo, bcryptRounds);
    await prisma.usuario.update({ where: { id: req.usuario.id }, data: { passwordHash: hash } });

    return res.json({ message: "Contraseña actualizada correctamente." });
  } catch (err) {
    console.error("Error changePassword:", err);
    return res.status(500).json({ error: "Error interno." });
  }
}

module.exports = { login, me, changePassword };
