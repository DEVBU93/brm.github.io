/**
 * BRM STREAM PROXY — Cloudflare Worker v2026.08
 * HTTPS wrapper + Status API para el stream Shoutcast BUBATRONIK_BRM RADIO
 * Frecuencia Sant Salvador · Sant Salvador, Tarragona, Catalunya
 *
 * Autor/Orquestador: Rubén Rodríguez Francisco (DEVBU93 · LOB@-Pulpo · ManadaSalvaje)
 * Nodo: Lob@-Pulpo × ROCE SYNC · WORLD-MUNDO OS
 *
 * Endpoints:
 *   /status      → JSON con estado real: live, song, listeners, bitrate
 *   /nowplaying  → JSON con canción actual e historial
 *   /health      → JSON health check legacy
 *   (default)    → Proxy del stream de audio MP3
 */

const STREAM_BASE = 'http://uk3freenew.listen2myradio.com:14387';
const STREAM_URL  = STREAM_BASE + '/';
const STATION     = 'BUBATRONIK_BRM · Frecuencia Sant Salvador';

const ALLOWED_ORIGINS = [
  'https://brm.worldmos.world',
  'https://worldmos.world',
  'https://aguaflow.worldmos.world',
  'https://devbu.worldmos.world',
  'https://devbu93.github.io',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
];

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

// Fetch con timeout usando AbortController (compatible con Workers runtime)
async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(tid);
    return res;
  } catch(e) {
    clearTimeout(tid);
    throw e;
  }
}

// SHOUTcast v1 7.html: currentlisteners,streamstatus,peaklisteners,maxlisteners,uniquelisteners,bitrate,songtitle
// El SHOUTcast puede devolver el CSV envuelto en HTML — hacemos strip antes de parsear
function parse7html(text) {
  const stripped = text.replace(/<[^>]+>/g, '').trim();
  const parts    = stripped.split(',');
  if (parts.length < 7) return null;
  const song = parts.slice(6).join(',').trim();
  const streamStatus = parseInt(parts[1], 10);
  let artist = '', title = song;
  const dash = song.indexOf(' - ');
  if (dash > -1) {
    artist = song.substring(0, dash).trim();
    title  = song.substring(dash + 3).trim();
  }
  return {
    live:             streamStatus === 1,
    currentListeners: parseInt(parts[0], 10),
    peakListeners:    parseInt(parts[2], 10),
    maxListeners:     parseInt(parts[3], 10),
    uniqueListeners:  parseInt(parts[4], 10),
    bitrate:          parseInt(parts[5], 10),
    song, artist, title,
  };
}

function parsePlayed(html) {
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
      if (time && songFull && /\d{2}:\d{2}/.test(time)) {
        let artist = '', title = songFull;
        const dash = songFull.indexOf(' - ');
        if (dash > -1) {
          artist = songFull.substring(0, dash).trim();
          title  = songFull.substring(dash + 3).trim();
        }
        rows.push({ time, song: songFull, artist, title });
      }
    }
  }
  return rows;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const hdrs   = { 'User-Agent': 'Mozilla/5.0 (compatible; BRM-Radio/2026)', 'Accept': 'text/plain' };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
    }

    if (url.pathname === '/status') {
      try {
        const res = await fetchWithTimeout(STREAM_BASE + '/7.html', { headers: hdrs }, 5000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = parse7html(await res.text());
        if (!data) throw new Error('parse failed');
        return new Response(JSON.stringify({
          status:        data.live ? 'online' : 'offline',
          live:          data.live,
          song:          data.song,
          artist:        data.artist,
          title:         data.title,
          listeners:     data.currentListeners,
          peakListeners: data.peakListeners,
          bitrate:       data.bitrate,
          station:       STATION,
          ts:            new Date().toISOString(),
        }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } });
      } catch (err) {
        return new Response(JSON.stringify({ status:'offline', live:false, error:String(err), ts:new Date().toISOString() }),
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } });
      }
    }

    if (url.pathname === '/nowplaying') {
      try {
        const [r7, rp] = await Promise.allSettled([
          fetchWithTimeout(STREAM_BASE + '/7.html',      { headers: hdrs }, 5000),
          fetchWithTimeout(STREAM_BASE + '/played.html', { headers: hdrs }, 5000),
        ]);
        const t7   = (r7.status === 'fulfilled' && r7.value.ok) ? await r7.value.text() : '0,0,0,0,0,0,';
        const html = (rp.status === 'fulfilled' && rp.value.ok) ? await rp.value.text() : '';
        const stat    = parse7html(t7) || { live:false, song:'', artist:'', title:'', currentListeners:0, bitrate:0 };
        const history = parsePlayed(html);
        const cur     = history[0] || { song:stat.song, artist:stat.artist, title:stat.title };
        return new Response(JSON.stringify({
          live:      stat.live,
          current:   { song:cur.song||stat.song, artist:cur.artist||stat.artist, title:cur.title||stat.title },
          listeners: stat.currentListeners,
          bitrate:   stat.bitrate,
          history:   history.slice(0,10),
          ts:        new Date().toISOString(),
        }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } });
      } catch (err) {
        return new Response(JSON.stringify({ live:false, current:{song:'',artist:'',title:''}, listeners:0, error:String(err) }),
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } });
      }
    }

    if (url.pathname === '/health') {
      let listeners = null;
      try {
        const res = await fetchWithTimeout(STREAM_BASE + '/7.html', { headers: hdrs }, 3000);
        if (res.ok) { const d = parse7html(await res.text()); if (d) listeners = d.currentListeners; }
      } catch(_) {}
      return new Response(JSON.stringify({ status:'ok', station:STATION, proxy:STREAM_URL, listeners, ts:new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...getCorsHeaders(origin) } });
    }

    // Proxy del stream de audio
    try {
      const up_h = new Headers();
      up_h.set('User-Agent', 'Mozilla/5.0 BRM-Proxy/2026');
      up_h.set('Icy-MetaData', '1');
      const range = request.headers.get('Range');
      if (range) up_h.set('Range', range);
      const upstream = await fetch(STREAM_URL, { method:'GET', headers:up_h });
      if (!upstream.ok && upstream.status !== 200) {
        return new Response(JSON.stringify({ error:'Stream no disponible', status:upstream.status }),
          { status:502, headers: { 'Content-Type':'application/json', ...getCorsHeaders(origin) } });
      }
      const rh = new Headers();
      ['content-type','icy-name','icy-genre','icy-url','icy-br','icy-sr','icy-metaint','icy-pub','icy-description','transfer-encoding','content-length']
        .forEach(h => { const v = upstream.headers.get(h); if (v) rh.set(h, v); });
      if (!rh.get('content-type')) rh.set('content-type', 'audio/mpeg');
      rh.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      rh.set('Pragma', 'no-cache');
      rh.set('Expires', '0');
      rh.set('X-BRM-Proxy', 'Lob@-Pulpo/2026');
      rh.set('X-Station', STATION);
      Object.entries(getCorsHeaders(origin)).forEach(([k,v]) => rh.set(k, v));
      return new Response(upstream.body, { status:upstream.status, headers:rh });
    } catch (err) {
      return new Response(JSON.stringify({ error:'Error de proxy', message:String(err) }),
        { status:500, headers: { 'Content-Type':'application/json', ...getCorsHeaders(origin) } });
    }
  },
};
