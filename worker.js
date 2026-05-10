/**
 * BRM STREAM PROXY — Cloudflare Worker v2026.07
 * HTTPS wrapper + Status API para el stream Shoutcast BUBATRONIK_BRM RADIO
 * Frecuencia Sant Salvador · Sant Salvador, Tarragona, Catalunya
 *
 * Autor/Orquestador: Rubén Rodríguez Francisco (DEVBU93 · LOB@-Pulpo · ManadaSalvaje)
 * Nodo: Lob@-Pulpo × ROCE SYNC · WORLD-MUNDO OS
 *
 * Endpoints:
 *   /stream      → Proxy del stream de audio (MP3)
 *   /status      → JSON con estado real: live, song, listeners, bitrate
 *   /nowplaying  → JSON con canción actual y historial de played.html
 *   /health      → JSON health check legacy
 */

// ── CONFIGURACIÓN ───────────────────────────────────────────────────────────
const STREAM_BASE = 'http://uk3freenew.listen2myradio.com:14387';
const STREAM_URL  = STREAM_BASE + '/';
const STATION     = 'BUBATRONIK_BRM · Frecuencia Sant Salvador';

const ALLOWED_ORIGINS = [
  // Producción
  'https://brm.worldmos.world',          // ✅ Dominio principal GoDaddy
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

// ── CORS HEADERS ────────────────────────────────────────────────────────────
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

// ── PARSE 7.html ─────────────────────────────────────────────────────────────
// Formato SHOUTcast v1: currentlisteners,streamstatus,peaklisteners,maxlisteners,uniquelisteners,bitrate,songtitle
function parse7html(text) {
  const parts = text.trim().split(',');
  if (parts.length < 7) return null;
  const song = parts.slice(6).join(',').trim();
  // Determinar si hay transmisión real (streamstatus=1 Y song no es vacío ni ID random)
  const streamStatus = parseInt(parts[1], 10);
  // Separar artista y título si hay ' - '
  let artist = '', title = song;
  const dash = song.indexOf(' - ');
  if (dash > -1) {
    artist = song.substring(0, dash).trim();
    title  = song.substring(dash + 3).trim();
  }
  return {
    live:           streamStatus === 1,
    currentListeners: parseInt(parts[0], 10),
    peakListeners:  parseInt(parts[2], 10),
    maxListeners:   parseInt(parts[3], 10),
    uniqueListeners: parseInt(parts[4], 10),
    bitrate:        parseInt(parts[5], 10),
    song:           song,
    artist:         artist,
    title:          title,
  };
}

// ── PARSE played.html ────────────────────────────────────────────────────────
// Extrae la canción actual y el historial de played.html
function parsePlayed(html) {
  // Buscar filas de la tabla (td elements)
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const tdRegex = /<td[^>]*>([^<]*)<\/td>/gi;
    const tds = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      tds.push(tdMatch[1].trim());
    }
    if (tds.length >= 2) {
      const time = tds[0];
      const songFull = tds[1];
      if (time && songFull && time.match(/\d{2}:\d{2}/)) {
        let artist = '', title = songFull;
        const dash = songFull.indexOf(' - ');
        if (dash > -1) {
          artist = songFull.substring(0, dash).trim();
          title  = songFull.substring(dash + 3).trim();
        }
        rows.push({ time, song: songFull, artist, title, current: tds.length > 2 });
      }
    }
  }
  return rows;
}

// ── HANDLER PRINCIPAL ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);

    // ── Preflight OPTIONS ───────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
    }

    // ── /status — Estado real del stream ────────────────────
    if (url.pathname === '/status') {
      try {
        const res = await fetch(STREAM_BASE + '/7.html', {
          headers: { 'User-Agent': 'BRM-Proxy/2026' },
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error('No ok: ' + res.status);
        const text = await res.text();
        const data = parse7html(text);
        if (!data) throw new Error('Parse error');
        return new Response(
          JSON.stringify({
            status:  data.live ? 'online' : 'offline',
            live:    data.live,
            song:    data.song,
            artist:  data.artist,
            title:   data.title,
            listeners: data.currentListeners,
            peakListeners: data.peakListeners,
            bitrate: data.bitrate,
            station: STATION,
            stream:  STREAM_URL,
            ts:      new Date().toISOString(),
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store',
              ...getCorsHeaders(origin),
            },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ status: 'offline', live: false, error: err.message, ts: new Date().toISOString() }),
          { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } }
        );
      }
    }

    // ── /nowplaying — Canción actual + historial ─────────────
    if (url.pathname === '/nowplaying') {
      try {
        const [statusRes, playedRes] = await Promise.all([
          fetch(STREAM_BASE + '/7.html', {
            headers: { 'User-Agent': 'BRM-Proxy/2026' },
            signal: AbortSignal.timeout(4000),
          }),
          fetch(STREAM_BASE + '/played.html', {
            headers: { 'User-Agent': 'BRM-Proxy/2026' },
            signal: AbortSignal.timeout(4000),
          }),
        ]);
        const statusText = statusRes.ok ? await statusRes.text() : '0,0,0,0,0,0,';
        const playedHtml = playedRes.ok ? await playedRes.text() : '';
        const stat    = parse7html(statusText) || { live: false, song: '', artist: '', title: '', currentListeners: 0, bitrate: 0 };
        const history = parsePlayed(playedHtml);
        const current = history.length > 0 ? history[0] : { song: stat.song, artist: stat.artist, title: stat.title };
        return new Response(
          JSON.stringify({
            live:    stat.live,
            current: {
              song:   current.song || stat.song,
              artist: current.artist || stat.artist,
              title:  current.title || stat.title,
            },
            listeners: stat.currentListeners,
            bitrate:   stat.bitrate,
            history:   history.slice(0, 10),
            ts: new Date().toISOString(),
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store',
              ...getCorsHeaders(origin),
            },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ live: false, current: { song: '', artist: '', title: '' }, listeners: 0, error: err.message }),
          { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } }
        );
      }
    }

    // ── /health — Health check legacy ────────────────────────
    if (url.pathname === '/health') {
      try {
        const res = await fetch(STREAM_BASE + '/7.html', {
          headers: { 'User-Agent': 'BRM-Proxy/2026' },
          signal: AbortSignal.timeout(3000),
        });
        let listeners = null;
        if (res.ok) {
          const data = parse7html(await res.text());
          if (data) listeners = data.currentListeners;
        }
        return new Response(
          JSON.stringify({ status: 'ok', station: STATION, proxy: STREAM_URL, listeners, ts: new Date().toISOString() }),
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } }
        );
      } catch (_) {
        return new Response(
          JSON.stringify({ status: 'ok', station: STATION, proxy: STREAM_URL, listeners: null, ts: new Date().toISOString() }),
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } }
        );
      }
    }

    // ── Proxy del stream (cualquier otra ruta) ───────────────
    try {
      const upstreamHeaders = new Headers();
      upstreamHeaders.set('User-Agent', 'Mozilla/5.0 BRM-Proxy/2026');
      upstreamHeaders.set('Icy-MetaData', '1');
      upstreamHeaders.set('Connection', 'keep-alive');
      const range = request.headers.get('Range');
      if (range) upstreamHeaders.set('Range', range);

      const upstream = await fetch(STREAM_URL, {
        method: 'GET',
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
      responseHeaders.set('Pragma', 'no-cache');
      responseHeaders.set('Expires', '0');
      responseHeaders.set('X-BRM-Proxy', 'Lob@-Pulpo/2026');
      responseHeaders.set('X-Station', STATION);
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
