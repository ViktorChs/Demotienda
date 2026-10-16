/*
 * config.js  -  Credenciales de Supabase para GIGAHEARTZ
 * ------------------------------------------------------------
 * Pega aqui tu Project URL y tu anon (publishable) key.
 * Estan en:  Supabase -> Project Settings -> API
 *
 * La anon key es PUBLICA (va en el navegador); la proteccion real
 * es RLS. NO pongas aqui la service_role key.
 */
window.GIGA_CONFIG = {
  SUPABASE_URL: 'https://isnbkqgzncjgttijzlmo.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_rMzQcYJeHfExcJn0PH6K4w_1QLvg_FR',
  STORAGE_BUCKET: 'images',

  // Multi-tienda: esta tienda (una base de datos, varias tiendas).
  // Todas las consultas del sitio filtran por este store_id.
  // Para otra tienda: cambia STORE_ID (o que el Worker lo inyecte por subdominio).
  STORE_ID: 1,
  STORE_SLUG: 'maniaworld',

  // Al subir una imagen desde el panel se convierte a WebP en el navegador
  // antes de enviarla (menos peso). Se salta SVG y GIF animado.
  IMAGE_MAX_WIDTH: 1600,
  IMAGE_WEBP_QUALITY: 0.82,

  // Fase G: CDN de imagenes (Cloudflare Worker en worker/). Solo CACHE
  // en el borde (gratis). Vacio = desactivado (se usa Supabase Storage
  // directo). Cuando se define, las imagenes del bucket se piden al
  // Worker: <IMAGE_CDN>/<ruta>
  IMAGE_CDN: ''
};
