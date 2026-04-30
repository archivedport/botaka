// src/config/cloudinary.js
// ============================================================
//  Cliente de Cloudinary para almacenamiento permanente de
//  imágenes de documentos médicos enviados por WhatsApp.
//
//  Las URLs de Meta expiran en minutos — Cloudinary las guarda
//  indefinidamente con CDN global.
// ============================================================

"use strict";

const { v2: cloudinary } = require("cloudinary");
const { cloudinaryConfig } = require("./env");

cloudinary.config({
  cloud_name: cloudinaryConfig.cloudName,
  api_key:    cloudinaryConfig.apiKey,
  api_secret: cloudinaryConfig.apiSecret,
  secure:     true,
});

/**
 * Sube una imagen en base64 a Cloudinary.
 *
 * @param {string} base64    — datos de la imagen en base64
 * @param {string} mimeType  — tipo MIME (image/jpeg, image/png, etc.)
 * @param {object} opts
 * @param {string} opts.folder    — carpeta en Cloudinary (ej: "documentos/cedulas")
 * @param {string} opts.publicId  — ID único del archivo (ej: "cedula_573...)
 * @returns {Promise<{ url: string, publicId: string }>}
 */
async function subirImagen(base64, mimeType, { folder = "documentos", publicId } = {}) {
  const dataUri = `data:${mimeType};base64,${base64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder,
    public_id:     publicId || undefined,
    resource_type: "image",
    overwrite:     true,
    tags:          ["documento_medico", "ips_ser_funcional"],

    // ── Optimización de almacenamiento ─────────────────────
    // Comprimir a JPEG calidad 85% — suficiente para leer documentos
    // Reduce ~70% del tamaño sin afectar legibilidad
    transformation: [
      {
        quality:  "85",
        fetch_format: "jpg",
        // Máx 1600px en el lado más largo — resolución suficiente para leer texto
        width:    1600,
        height:   1600,
        crop:     "limit",   // solo reduce, nunca agranda
      }
    ],

    // Deshabilitar backup automático — no necesitamos versiones históricas
    // de documentos médicos en Cloudinary (ya están en LogIA de PostgreSQL)
    backup:     false,
  });

  return {
    url:      result.secure_url,
    publicId: result.public_id,
  };
}

/**
 * Elimina una imagen de Cloudinary.
 * Útil si el paciente reinicia el flujo y reenvía el documento.
 */
async function eliminarImagen(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.warn("⚠️ Cloudinary eliminarImagen:", e.message);
  }
}

module.exports = { subirImagen, eliminarImagen };
