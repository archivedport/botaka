-- CreateEnum
CREATE TYPE "RolUsuario" AS ENUM ('ADMIN', 'ASESOR');

-- CreateEnum
CREATE TYPE "EstadoChat" AS ENUM ('BOT', 'MANUAL');

-- CreateEnum
CREATE TYPE "EstadoCita" AS ENUM ('PENDIENTE', 'CONFIRMADA', 'CANCELADA', 'COMPLETADA', 'NO_ASISTIO');

-- CreateEnum
CREATE TYPE "TipoDocumentoIA" AS ENUM ('CEDULA', 'CARNET_EPS', 'ORDEN_MEDICA', 'RESULTADO_LAB', 'OTRO');

-- CreateEnum
CREATE TYPE "AccionAuditoria" AS ENUM ('VER_HISTORIA', 'CREAR_CITA', 'CANCELAR_CITA', 'CONFIRMAR_CITA', 'TOMAR_CONTROL_CHAT', 'LIBERAR_CHAT', 'PROCESAR_DOCUMENTO', 'EDITAR_PACIENTE', 'EXPORTAR_DATOS');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "rol" "RolUsuario" NOT NULL DEFAULT 'ASESOR',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "ultimoAcceso" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pacientes" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "nombre" TEXT,
    "documento" TEXT,
    "tipoDocumento" TEXT DEFAULT 'CC',
    "fechaNacimiento" TIMESTAMP(3),
    "email" TEXT,
    "celular" TEXT,
    "eps" TEXT,
    "vigenciaEPS" TIMESTAMP(3),
    "sede" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pacientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sedes" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "direccion" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sedes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "horarios_sede" (
    "id" TEXT NOT NULL,
    "sedeId" TEXT NOT NULL,
    "diaSemana" INTEGER NOT NULL,
    "apertura" TEXT NOT NULL,
    "cierre" TEXT NOT NULL,
    "duracionSlot" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "horarios_sede_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citas" (
    "id" TEXT NOT NULL,
    "pacienteId" TEXT NOT NULL,
    "sedeId" TEXT NOT NULL,
    "asesorId" TEXT,
    "especialidad" TEXT NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL,
    "fechaFin" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoCita" NOT NULL DEFAULT 'PENDIENTE',
    "motivoConsulta" TEXT,
    "notas" TEXT,
    "recordatorio24h" BOOLEAN NOT NULL DEFAULT false,
    "recordatorio2h" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "citas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs_ia" (
    "id" TEXT NOT NULL,
    "pacienteId" TEXT,
    "asesorId" TEXT,
    "mediaId" TEXT NOT NULL,
    "tipoDocumento" "TipoDocumentoIA" NOT NULL,
    "resultadoRaw" JSONB NOT NULL,
    "resultadoParsed" JSONB,
    "confianza" DOUBLE PRECISION,
    "validadoPor" TEXT,
    "validadoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_ia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs_auditoria" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "accion" "AccionAuditoria" NOT NULL,
    "entidadTipo" TEXT,
    "entidadId" TEXT,
    "detalle" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE UNIQUE INDEX "pacientes_phone_key" ON "pacientes"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "pacientes_documento_key" ON "pacientes"("documento");

-- CreateIndex
CREATE UNIQUE INDEX "sedes_slug_key" ON "sedes"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "horarios_sede_sedeId_diaSemana_key" ON "horarios_sede"("sedeId", "diaSemana");

-- CreateIndex
CREATE INDEX "citas_fechaInicio_sedeId_especialidad_idx" ON "citas"("fechaInicio", "sedeId", "especialidad");

-- CreateIndex
CREATE INDEX "citas_pacienteId_idx" ON "citas"("pacienteId");

-- CreateIndex
CREATE INDEX "logs_auditoria_usuarioId_createdAt_idx" ON "logs_auditoria"("usuarioId", "createdAt");

-- CreateIndex
CREATE INDEX "logs_auditoria_entidadTipo_entidadId_idx" ON "logs_auditoria"("entidadTipo", "entidadId");

-- AddForeignKey
ALTER TABLE "horarios_sede" ADD CONSTRAINT "horarios_sede_sedeId_fkey" FOREIGN KEY ("sedeId") REFERENCES "sedes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citas" ADD CONSTRAINT "citas_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "pacientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citas" ADD CONSTRAINT "citas_sedeId_fkey" FOREIGN KEY ("sedeId") REFERENCES "sedes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citas" ADD CONSTRAINT "citas_asesorId_fkey" FOREIGN KEY ("asesorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_ia" ADD CONSTRAINT "logs_ia_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "pacientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_ia" ADD CONSTRAINT "logs_ia_asesorId_fkey" FOREIGN KEY ("asesorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_auditoria" ADD CONSTRAINT "logs_auditoria_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
