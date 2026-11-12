import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import upstream from './index.js';
import { extract } from './src/extractors/nxsha.js';
import { encodeProxyUrl } from './src/proxy.js';
const { ADMIN_TOKEN, SIGNING_SECRET, ALLOWED_ORIGIN, TORRSERVER_URL } = process.env;
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32 || !SIGNING_SECRET || SIGNING_SECRET.length < 32 || !ALLOWED_ORIGIN) throw new Error('Configure ADMIN_TOKEN, SIGNING_SECRET (32+ characters) and ALLOWED_ORIGIN');
if (!TORRSERVER_URL) throw new Error('Configure TORRSERVER_URL');
const YTS_HOSTS = ['https://yts.mx', 'https://yts.lt', 'https://yts.am'];
const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.demonii.com:1337/announce', 'udp://tracker.openbittorrent.com:80', 'udp://tracker.torrent.eu.org:451/announce', 'udp://open.stealth.si:80/announce', 'udp://exodus.desync.com:6969/announce', 'udp://tracker.moeru.ai:6969/announce'];
async function searchYts(title, year) {
  let movies = null;
  for (const host of YTS_HOSTS) {
    try {
      const r = await fetch(`${host}/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&limit=20`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const d = await r.json();
      movies = d?.data?.movies || [];
      break;
    } catch {}
  }
  if (movies === null) throw new Error('YTS unavailable');
  const norm = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const q = norm(title);
  let list = movies.filter(m => !year || String(m.year) === year);
  const exact = list.filter(m => norm(m.title) === q || norm(m.title_english || '') === q);
  if (exact.length) list = exact;
  else if (title) list = list.filter(m => norm(m.title).includes(q) || q.includes(norm(m.title)));
  const items = [];
  for (const m of list) for (const t of m.torrents || []) {
    if (!t.hash) continue;
    const hevc = /x265|hevc/i.test(t.video_codec || '') || t.quality === '2160p';
    items.push({ m, t, hevc });
  }
  if (!items.length) return null;
  const pool = items.some(i => !i.hevc) ? items.filter(i => !i.hevc) : items;
  pool.sort((a, b) => (b.t.seeds || 0) - (a.t.seeds || 0));
  const { m, t } = pool[0];
  const name = `${m.title_long || m.title} [${t.quality}]`;
  const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(name)}` + TRACKERS.map(x => '&tr=' + encodeURIComponent(x)).join('');
  return { magnet, name, seeders: t.seeds || 0, size: t.size_bytes || 0 };
}
const app = new Hono();
let extracting = 0;
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function signature(u) {
  const q = new URLSearchParams(u.search); q.delete('sig'); q.sort();
  return createHmac('sha256', SIGNING_SECRET).update(u.pathname + '?' + q.toString()).digest('hex');
}
function signed(raw, base, expiry) {
  const u = new URL(raw, base);
  if (u.origin !== new URL(base).origin || u.pathname !== '/proxy') throw new Error('Unexpected proxy URL');
  const target = new URL(u.searchParams.get('url'));
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Unsupported video URL');
  u.searchParams.set('exp', String(expiry)); u.searchParams.delete('sig'); u.searchParams.set('sig', signature(u));
  return u.href;
}
app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && origin !== ALLOWED_ORIGIN) return c.json({ error: 'Origin not allowed' }, 403);
  if (origin) { c.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN); c.header('Vary', 'Origin'); }
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  c.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});
app.get('/health', c => c.json({ ok: true, provider: 'nxsha', mode: 'protected-test' }));
app.use('/api/extract', bodyLimit({ maxSize: 2048 }));
app.post('/api/extract', async c => {
  if (!equal(c.req.header('authorization') || '', 'Bearer ' + ADMIN_TOKEN)) return c.json({ error: 'Authentication required' }, 401);
  let input;
  try {
    const body = await c.req.json();
    input = String(body.url || '');
    if (/^[1-9]\d*$/.test(input)) input = 'https://www.themoviedb.org/movie/' + input;
    const u = new URL(input);
    if (u.origin !== 'https://www.themoviedb.org' || u.search || u.hash || u.username || u.password || !/^\/(movie\/[1-9]\d*|tv\/[1-9]\d*\/season\/[1-9]\d*\/episode\/[1-9]\d*)$/.test(u.pathname)) throw new Error();
  } catch { return c.json({ error: 'Expected a TMDB movie or episode URL' }, 400); }
  if (extracting >= 2) return c.json({ error: 'Busy, retry later' }, 429);
  extracting++;
  try {
    const result = await extract(input);
    const expiry = Math.floor(Date.now() / 1000) + 14400;
    const base = new URL(c.req.url).origin;
    const servers = (result.servers || []).map(s => ({ name: s.name, type: s.type, quality: s.quality || '', proxyUrl: signed(encodeProxyUrl(s.url, s.referer, base, s.headers), base, expiry) }));
    return c.json({ servers });
  } catch { return c.json({ error: 'Nxsha extraction failed; inspect source availability' }, 502); }
  finally { extracting--; }
});
app.use('/api/torrent/search', bodyLimit({ maxSize: 2048 }));
app.post('/api/torrent/search', async c => {
  if (!equal(c.req.header('authorization') || '', 'Bearer ' + ADMIN_TOKEN)) return c.json({ error: 'Authentication required' }, 401);
  let title, year;
  try {
    const body = await c.req.json();
    title = String(body.title || '').trim();
    year = String(body.year || '').trim();
    if (!title) throw new Error();
  } catch { return c.json({ error: 'Expected a movie title' }, 400); }
  try {
    const best = await searchYts(title, year);
    if (!best) return c.json({ error: 'Source not found' }, 404);
    return c.json(best);
  } catch { return c.json({ error: 'Torrent search failed' }, 502); }
});
app.use('/api/torrent/stream', bodyLimit({ maxSize: 4096 }));
app.post('/api/torrent/stream', async c => {
  if (!equal(c.req.header('authorization') || '', 'Bearer ' + ADMIN_TOKEN)) return c.json({ error: 'Authentication required' }, 401);
  let magnet;
  try {
    const body = await c.req.json();
    magnet = String(body.magnet || '');
    if (!magnet.startsWith('magnet:?xt=urn:btih:')) throw new Error();
  } catch { return c.json({ error: 'Expected a magnet link' }, 400); }
  try {
    const addResponse = await fetch(`${TORRSERVER_URL}/torrents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', link: magnet, title: 'Torrent', save_to_db: false })
    });
    if (!addResponse.ok) throw new Error('TorrServer add failed');
    const hash = new URL(magnet).searchParams.get('xt')?.replace('urn:btih:', '');
    if (!hash) throw new Error('Invalid magnet hash');
    for (let attempt = 0; attempt < 60; attempt++) {
      const statusResponse = await fetch(`${TORRSERVER_URL}/torrents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', hash })
      });
      const status = await statusResponse.json();
      if (status.stat_string === 'Torrent working') {
        const internalStreamUrl = `${TORRSERVER_URL}/stream?link=${encodeURIComponent(magnet)}&play=true&index=1`;
        const expiry = Math.floor(Date.now() / 1000) + 14400;
        const base = new URL(c.req.url).origin;
        const proxyUrl = signed(encodeProxyUrl(internalStreamUrl, '', base, {}), base, expiry);
        return c.json({ streamUrl: proxyUrl });
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('TorrServer did not become ready');
  } catch { return c.json({ error: 'TorrServer stream failed' }, 502); }
});
app.get('/proxy', async c => {
  const u = new URL(c.req.url), expiry = Number(u.searchParams.get('exp'));
  if (!Number.isSafeInteger(expiry) || expiry < Date.now() / 1000 || expiry > Date.now() / 1000 + 14460 || !equal(u.searchParams.get('sig') || '', signature(u))) return c.json({ error: 'Invalid or expired video link' }, 403);
  try {
    u.searchParams.delete('sig'); u.searchParams.delete('exp');
    const response = await upstream.fetch(new Request(u, { headers: { Range: c.req.header('range') || '' } }));
    const headers = new Headers(response.headers);
    headers.delete('access-control-allow-origin'); headers.set('cache-control', 'no-store');
    if (/mpegurl/i.test(headers.get('content-type') || '')) {
      const text = (await response.text()).replace(/https?:\/\/[^\s"'<>]+\/proxy\?[^\s"'<>]+/g, raw => signed(raw, u.origin, expiry));
      headers.delete('content-length');
      return new Response(text, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch { return c.json({ error: 'Video upstream unavailable' }, 502); }
});
app.onError((_error, c) => c.json({ error: 'Backend error' }, 500));
serve({ fetch: app.fetch, hostname: '0.0.0.0', port: Number(process.env.PORT || 10000) });
