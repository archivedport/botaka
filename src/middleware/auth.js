// src/middleware/auth.js
// ============================================================
//  Middleware de autenticación JWT y control de roles.
// ============================================================

"use strict";

const jwt    = require("jsonwebtoken");
const prisma = require("../config/database");
const { jwt: jwtConfig } = require("../config/env");

// ── Generar token ────────────────────────────────────────────

function generarToken(usuario) {
  return jwt.sign(
    {
      sub:   usuario.id,
      email: usuario.email,
      rol:   usuario.rol,
      nombre: usuario.nombre,
    },
    jwtConfig.secret,
    { expiresIn: jwtConfig.expiresIn }
  );
}

// ── Middleware: verificar JWT ────────────────────────────────

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token no proporcionado." });
    }

    const token   = header.slice(7);
    const payload = jwt.verify(token, jwtConfig.secret);

    // Verificar que el usuario siga activo en BD
    const usuario = await prisma.usuario.findUnique({
      where:  { id: payload.sub },
      select: { id: true, nombre: true, email: true, rol: true, activo: true },
    });

    if (!usuario || !usuario.activo) {
      return res.status(401).json({ error: "Usuario inactivo o no encontrado." });
    }

    req.usuario = usuario;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expirado." });
    }
    return res.status(401).json({ error: "Token inválido." });
  }
}

// ── Middleware: verificar rol ────────────────────────────────

function requireRol(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario?.rol)) {
      return res.status(403).json({ error: "Sin permisos para esta acción." });
    }
    next();
  };
}

// ── Middleware: actualizar último acceso (async, no bloqueante) ──

function trackAcceso(req, _res, next) {
  prisma.usuario.update({
    where: { id: req.usuario.id },
    data:  { ultimoAcceso: new Date() },
  }).catch(() => {}); // silencioso
  next();
}

module.exports = { generarToken, requireAuth, requireRol, trackAcceso };
