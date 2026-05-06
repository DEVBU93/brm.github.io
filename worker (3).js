/**
 * BRM STREAM PROXY — Cloudflare Worker
 * HTTPS wrapper para el stream Shoutcast HTTP de BUBATRONIK_BRM RADIO
 * Frecuencia Sant Salvador · Sant Salvador, Tarragona, Catalunya
 *
 * Autor/Orquestador: Rubén Rodríguez Francisco (DEVBU93 · LOB@-Pulpo · ManadaSalvaje)
 * Nodo: Lob@-Pulpo × ROCE SYNC · WORLD-MUNDO OS
 *
 * Deploy: https://dash.cloudflare.com → Workers → Create Worker
 * URL:    https://brm.rubenrodriguez-f-93.workers.dev/stream
 */

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────
const STREAM_URL = 'http://uk4freenew.listen2myradio.com:25771/';
const STATION    = 'BUBATRONIK_BRM · Frecuencia Sant Salvador';

const ALLOWED_ORIGINS = [
  // Producción
  'https://brm.worldmos.world',           // ✅ Dominio principal GoDaddy
  'https://worldmos.world',
  'https://aguaflow.worldmos.world',
  'https://devbu.worldmos.world',
  // GitHub Pages
  'https://devbu93.github.io',
  // Dev local
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
];

// ── CORS HEADERS ──────────────────────────────────────────────────────────
function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':   allowed,
    'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers':  'Range, Content-Type, Icy-MetaData',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, icy-name, icy-genre, icy-br, icy-metaint',
    'Access-Control-Max-Age':        '86400',
  };
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);

    // ── Preflight OPTIONS ─────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
    }

    // ── Health check → /health ────────────────────────────
    if (url.pathname === '/health') {
      // Intentar obtener stats del Shoutcast
      let listeners = null;
      try {
        const statsRes = await fetch(STREAM_URL + 'stats?json=1', {
          headers: { 'User-Agent': 'BRM-Proxy/2026' },
          signal: AbortSignal.timeout(3000),
        });
        if (statsRes.ok) {
          const stats = await statsRes.json();
          listeners = stats.currentlisteners ?? stats.listeners ?? null;
        }
      } catch (_) { /* sin stats disponibles */ }

      return new Response(
        JSON.stringify({
          status:   'ok',
          station:  STATION,
          proxy:    STREAM_URL,
          listeners,
          ts:       new Date().toISOString(),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            ...getCorsHeaders(origin),
          },
        }
      );
    }

    // ── Proxy del stream (cualquier otra ruta) ────────────
    try {
      const upstreamHeaders = new Headers();
      upstreamHeaders.set('User-Agent',   'Mozilla/5.0 BRM-Proxy/2026');
      upstreamHeaders.set('Icy-MetaData', '1');
      upstreamHeaders.set('Connection',   'keep-alive');
      const range = request.headers.get('Range');
      if (range) upstreamHeaders.set('Range', range);

      const upstream = await fetch(STREAM_URL, {
        method:  'GET',
        headers: upstreamHeaders,
      });

      if (!upstream.ok && upstream.status !== 200) {
        return new Response(
          JSON.stringify({ error: 'Stream upstream no disponible', status: upstream.status }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(origin) } }
        );
      }

      const responseHeaders = new Headers();
      ['content-type','icy-name','icy-genre','icy-url','icy-br','icy-sr',
       'icy-metaint','icy-pub','icy-description','transfer-encoding','content-length'].forEach(h => {
        const v = upstream.headers.get(h);
        if (v) responseHeaders.set(h, v);
      });

      if (!responseHeaders.get('content-type')) responseHeaders.set('content-type', 'audio/mpeg');
      responseHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      responseHeaders.set('Pragma',        'no-cache');
      responseHeaders.set('Expires',       '0');
      responseHeaders.set('X-BRM-Proxy',   'Lob@-Pulpo/2026');
      responseHeaders.set('X-Station',     STATION);

      Object.entries(getCorsHeaders(origin)).forEach(([k,v]) => responseHeaders.set(k, v));

      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Error de proxy', message: err.message, station: STATION }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(origin) } }
      );
    }
  },
};
