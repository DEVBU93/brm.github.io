/**
 * BRM STREAM PROXY — Cloudflare Worker
 * HTTPS wrapper para el stream Shoutcast HTTP de BUBATRONIK_BRM RADIO
 * 
 * Autor/Orquestador: Rubén Rodríguez Francisco (DEVBU93 · LOB@-Pulpo · ManadaSalvaje)
 * Nodo: Lob@-Pulpo × ROCE SYNC
 * 
 * Deploy: https://dash.cloudflare.com → Workers → Create Worker → pegar este código
 * URL resultante: https://brm-stream.TU-SUBDOMINIO.workers.dev/stream
 */

// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────
const STREAM_URL  = 'http://uk4freenew.listen2myradio.com:25771/';
const STATION     = 'BUBATRONIK_BRM RADIO';
const ALLOWED_ORIGINS = [
  'https://devbu93.github.io',         // GitHub Pages
  'https://brm.worldmos.world',        // Subdominio GoDaddy/Cloudflare
  'https://worldmos.world',
  'https://aguaflow.worldmos.world',
  'https://devbu.worldmos.world',
  'http://localhost:3000',             // Dev local
  'http://localhost:4000',             // Jekyll local
  'http://127.0.0.1:5500',            // Live Server VSCode
];

// ── CORS HEADERS ──────────────────────────────────────────────────────────
function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Icy-MetaData',
    'Access-Control-Expose-Headers':'Content-Type, Content-Length, icy-name, icy-genre, icy-br, icy-metaint',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);

    // ── Preflight OPTIONS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(origin),
      });
    }

    // ── Health check endpoint → /health
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status:  'ok',
          station: STATION,
          proxy:   STREAM_URL,
          ts:      new Date().toISOString(),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(origin),
          },
        }
      );
    }

    // ── Cualquier otra ruta → proxy del stream
    try {
      // Construir headers para la petición upstream
      const upstreamHeaders = new Headers();
      upstreamHeaders.set('User-Agent',    'Mozilla/5.0 BRM-Proxy/2026');
      upstreamHeaders.set('Icy-MetaData',  '1'); // pedir metadatos ICY
      upstreamHeaders.set('Connection',    'keep-alive');

      // Pasar Range header si existe (para seeking futuro)
      const range = request.headers.get('Range');
      if (range) upstreamHeaders.set('Range', range);

      // Fetch al stream HTTP
      const upstream = await fetch(STREAM_URL, {
        method:  'GET',
        headers: upstreamHeaders,
        // Cloudflare Workers soporta streaming responses
      });

      if (!upstream.ok && upstream.status !== 200) {
        return new Response(
          JSON.stringify({ error: 'Stream upstream no disponible', status: upstream.status }),
          {
            status:  502,
            headers: {
              'Content-Type': 'application/json',
              ...getCorsHeaders(origin),
            },
          }
        );
      }

      // Construir headers de respuesta
      const responseHeaders = new Headers();

      // Copiar headers relevantes del upstream
      const copyHeaders = [
        'content-type',
        'icy-name',
        'icy-genre',
        'icy-url',
        'icy-br',
        'icy-sr',
        'icy-metaint',
        'icy-pub',
        'icy-description',
        'transfer-encoding',
        'content-length',
      ];

      for (const h of copyHeaders) {
        const val = upstream.headers.get(h);
        if (val) responseHeaders.set(h, val);
      }

      // Forzar audio/mpeg si no viene content-type
      if (!responseHeaders.get('content-type')) {
        responseHeaders.set('content-type', 'audio/mpeg');
      }

      // Headers de cache: no cachear streams
      responseHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      responseHeaders.set('Pragma',        'no-cache');
      responseHeaders.set('Expires',       '0');

      // Headers CORS
      const cors = getCorsHeaders(origin);
      for (const [k, v] of Object.entries(cors)) {
        responseHeaders.set(k, v);
      }

      // Header identificador del proxy
      responseHeaders.set('X-BRM-Proxy',    'Lob@-Pulpo/2026');
      responseHeaders.set('X-Station-Name', STATION);

      return new Response(upstream.body, {
        status:  upstream.status,
        headers: responseHeaders,
      });

    } catch (err) {
      return new Response(
        JSON.stringify({
          error:   'Error de proxy',
          message: err.message,
          station: STATION,
        }),
        {
          status:  500,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders(origin),
          },
        }
      );
    }
  },
};
