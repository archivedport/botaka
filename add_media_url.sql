-- Migration: add_media_url_to_mensajes
-- Añade columna mediaUrl a la tabla mensajes para guardar
-- URLs de Cloudinary cuando el mensaje contiene una imagen.

ALTER TABLE "mensajes" ADD COLUMN "mediaUrl" TEXT;
