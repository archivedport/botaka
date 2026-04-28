require("dotenv").config();
// src/config/env.js
// ============================================================
//  Validación estricta de variables de entorno al arranque.
//  El proceso termina si falta cualquier variable obligatoria.
// ============================================================

"use strict";

const REQUIRED = [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "META_ACCESS_TOKEN",
  "META_PHONE_ID",
  "META_API_VERSION",
  "META_VERIFY_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

const OPTIONAL_DEFAULTS = {
  PORT:            "3000",
  NODE_ENV:        "production",
  JWT_EXPIRES_IN:  "8h",
  BCRYPT_ROUNDS:   "12",
  SLOT_DURATION:   "30",        // minutos
  MAX_SLOTS_LIST:  "8",
};

function validateEnv() {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) {
    console.error("\n❌ Variables de entorno faltantes:");
    missing.forEach(k => console.error(`   • ${k}`));
    console.error("\nRevisa tu archivo .env o las variables de Railway.\n");
    process.exit(1);
  }

  // Aplicar defaults para opcionales
  for (const [k, v] of Object.entries(OPTIONAL_DEFAULTS)) {
    if (!process.env[k]) process.env[k] = v;
  }

  console.log("✅ Variables de entorno validadas.");
}

validateEnv();

module.exports = {
  PORT:           parseInt(process.env.PORT),
  NODE_ENV:       process.env.NODE_ENV,
  DATABASE_URL:   process.env.DATABASE_URL,
  REDIS_URL:      process.env.REDIS_URL,

  jwt: {
    secret:     process.env.JWT_SECRET,
    expiresIn:  process.env.JWT_EXPIRES_IN,
  },

  meta: {
    token:      process.env.META_ACCESS_TOKEN,
    phoneId:    process.env.META_PHONE_ID,
    version:    process.env.META_API_VERSION,
    verifyToken: process.env.META_VERIFY_TOKEN,
    baseUrl:    () => `https://graph.facebook.com/${process.env.META_API_VERSION}`,
  },

  gemini: {
    apiKey:     process.env.GEMINI_API_KEY || "",  // ya no se usa activamente
    model:      "gemini-1.5-flash",
  },

  anthropic: {
    apiKey:     process.env.ANTHROPIC_API_KEY,
    model:      "claude-haiku-4-5-20251001",
  },

  cloudinaryConfig: {
    cloudName:  process.env.CLOUDINARY_CLOUD_NAME,
    apiKey:     process.env.CLOUDINARY_API_KEY,
    apiSecret:  process.env.CLOUDINARY_API_SECRET,
  },

  bcryptRounds:  parseInt(process.env.BCRYPT_ROUNDS),
  slotDuration:  parseInt(process.env.SLOT_DURATION),
  maxSlotsList:  parseInt(process.env.MAX_SLOTS_LIST),
};
