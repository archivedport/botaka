-- ============================================================
--  Migration inicial — IPS Salud Vida
--  Generada para referencia. Usar: npx prisma migrate dev
-- ============================================================

-- Enums
CREATE TYPE "RolUsuario"      AS ENUM ('ADMIN', 'ASESOR');
CREATE TYPE "EstadoChat"      AS ENUM ('BOT', 'MANUAL');
CREATE TYPE "EstadoCita"      AS ENUM ('PENDIENTE', 'CONFIRMADA', 'CANCELADA', 'COMPLETADA', 'NO_ASISTIO');
CREATE TYPE "TipoDocumentoIA" AS ENUM ('CEDULA', 'CARNET_EPS', 'ORDEN_MEDICA', 'RESULTADO_LAB', 'OTRO');
CREATE TYPE "AccionAuditoria" AS ENUM (
  'VER_HISTORIA', 'CREAR_CITA', 'CANCELAR_CITA', 'CONFIRMAR_CITA',
  'TOMAR_CONTROL_CHAT', 'LIBERAR_CHAT', 'PROCESAR_DOCUMENTO',
  'EDITAR_PACIENTE', 'EXPORTAR_DATOS'
);

-- Usuarios
CREATE TABLE "usuarios" (
  "id"           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "nombre"       TEXT        NOT NULL,
  "email"        TEXT        UNIQUE NOT NULL,
  "passwordHash" TEXT        NOT NULL,
  "rol"          "RolUsuario" NOT NULL DEFAULT 'ASESOR',
  "activo"       BOOLEAN     NOT NULL DEFAULT true,
  "ultimoAcceso" TIMESTAMP,
  "createdAt"    TIMESTAMP   NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMP   NOT NULL DEFAULT now()
);

-- Pacientes
CREATE TABLE "pacientes" (
  "id"              TEXT      PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "phone"           TEXT      UNIQUE NOT NULL,
  "nombre"          TEXT,
  "documento"       TEXT      UNIQUE,
  "tipoDocumento"   TEXT      DEFAULT 'CC',
  "fechaNacimiento" TIMESTAMP,
  "email"           TEXT,
  "celular"         TEXT,
  "eps"             TEXT,
  "vigenciaEPS"     TIMESTAMP,
  "sede"            TEXT,
  "createdAt"       TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMP NOT NULL DEFAULT now()
);

-- Sedes
CREATE TABLE "sedes" (
  "id"        TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "slug"      TEXT    UNIQUE NOT NULL,
  "nombre"    TEXT    NOT NULL,
  "direccion" TEXT    NOT NULL,
  "telefono"  TEXT    NOT NULL,
  "activa"    BOOLEAN NOT NULL DEFAULT true
);

-- Horarios de sede
CREATE TABLE "horarios_sede" (
  "id"           TEXT    PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sedeId"       TEXT    NOT NULL REFERENCES "sedes"("id"),
  "diaSemana"    INTEGER NOT NULL,
  "apertura"     TEXT    NOT NULL,
  "cierre"       TEXT    NOT NULL,
  "duracionSlot" INTEGER NOT NULL DEFAULT 30,
  UNIQUE ("sedeId", "diaSemana")
);

-- Citas
CREATE TABLE "citas" (
  "id"             TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "pacienteId"     TEXT         NOT NULL REFERENCES "pacientes"("id"),
  "sedeId"         TEXT         NOT NULL REFERENCES "sedes"("id"),
  "asesorId"       TEXT         REFERENCES "usuarios"("id"),
  "especialidad"   TEXT         NOT NULL,
  "fechaInicio"    TIMESTAMP    NOT NULL,
  "fechaFin"       TIMESTAMP    NOT NULL,
  "estado"         "EstadoCita" NOT NULL DEFAULT 'PENDIENTE',
  "motivoConsulta" TEXT,
  "notas"          TEXT,
  "recordatorio24h" BOOLEAN     NOT NULL DEFAULT false,
  "recordatorio2h"  BOOLEAN     NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP    NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMP    NOT NULL DEFAULT now()
);

CREATE INDEX "citas_fechaInicio_sedeId_especialidad_idx" ON "citas" ("fechaInicio", "sedeId", "especialidad");
CREATE INDEX "citas_pacienteId_idx"                       ON "citas" ("pacienteId");

-- Logs IA
CREATE TABLE "logs_ia" (
  "id"              TEXT              PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "pacienteId"      TEXT              REFERENCES "pacientes"("id"),
  "asesorId"        TEXT              REFERENCES "usuarios"("id"),
  "mediaId"         TEXT              NOT NULL,
  "tipoDocumento"   "TipoDocumentoIA" NOT NULL,
  "resultadoRaw"    JSONB             NOT NULL,
  "resultadoParsed" JSONB,
  "confianza"       FLOAT,
  "validadoPor"     TEXT,
  "validadoEn"      TIMESTAMP,
  "createdAt"       TIMESTAMP         NOT NULL DEFAULT now()
);

-- Logs de auditoría
CREATE TABLE "logs_auditoria" (
  "id"          TEXT              PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "usuarioId"   TEXT              NOT NULL REFERENCES "usuarios"("id"),
  "accion"      "AccionAuditoria" NOT NULL,
  "entidadTipo" TEXT,
  "entidadId"   TEXT,
  "detalle"     JSONB,
  "ip"          TEXT,
  "userAgent"   TEXT,
  "createdAt"   TIMESTAMP         NOT NULL DEFAULT now()
);

CREATE INDEX "logs_auditoria_usuarioId_createdAt_idx" ON "logs_auditoria" ("usuarioId", "createdAt");
CREATE INDEX "logs_auditoria_entidadTipo_entidadId_idx" ON "logs_auditoria" ("entidadTipo", "entidadId");
