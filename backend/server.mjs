import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
async function searchYts(title, year, quality) {
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
  let items = [];
  for (const m of list) for (const t of m.torrents || []) {
    if (!t.hash) continue;
    const hevc = /x265|hevc/i.test(t.video_codec || '') || t.quality === '2160p';
    items.push({ m, t, hevc });
  }
  if (quality) items = items.filter(i => i.t.quality === quality);
  if (!items.length) return null;
  const pool = items.some(i => !i.hevc) ? items.filter(i => !i.hevc) : items;
  pool.sort((a, b) => (b.t.seeds || 0) - (a.t.seeds || 0));
  const { m, t } = pool[0];
  const name = `${m.title_long || m.title} [${t.quality}]`;
  const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(name)}` + TRACKERS.map(x => '&tr=' + encodeURIComponent(x)).join('');
  return { magnet, name, seeders: t.seeds || 0, size: t.size_bytes || 0, hash: t.hash };
}
const TORRENTIO = (process.env.TORRENTIO_URL || 'https://torrentio.strem.fun').replace(/\/$/, '');
const RU_RE = /🇷🇺|\brus(sian)?\b|дубл|озвуч|\bdub|\bmvo\b|\bdvo\b|\bavo\b|lostfilm|pifagor|kubik|hdrezka/i;
async function imdbId(title, year) {
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(title)}.json`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const metas = ((await r.json()).metas || []).filter(m => /^tt\d+$/.test(m.id));
    const m = year ? metas.find(x => String(x.year || x.releaseInfo || '').startsWith(String(year))) : metas[0];
    return m ? m.id : null;
  } catch { return null; }
}
async function searchTorrentio(title, year, quality, lang, imdb) {
  const id = imdb || await imdbId(title, year);
  if (!id) return null;
  const opts = ['providers=yts,eztv,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,rutor,rutracker', 'sort=seeders', 'qualityfilter=brremux,scr,cam'];
  if (lang === 'ru') opts.push('language=russian');
  const r = await fetch(`${TORRENTIO}/${opts.join('|')}/stream/movie/${id}.json`, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('Torrentio HTTP ' + r.status);
  const items = [];
  for (const s of (await r.json()).streams || []) {
    if (!s.infoHash) continue;
    const text = `${s.name || ''}\n${s.title || ''}`;
    const q = /2160p|4k/i.test(text) ? '2160p' : /1080p/i.test(text) ? '1080p' : /720p/i.test(text) ? '720p' : '';
    if (quality && q !== quality) continue;
    if (lang === 'ru' && !RU_RE.test(text)) continue;
    const seeds = +((/👤\s*(\d+)/.exec(text) || [])[1] || 0);
    const sm = /💾\s*([\d.]+)\s*(GB|MB)/i.exec(text);
    const size = sm ? Math.round(parseFloat(sm[1]) * (sm[2].toUpperCase() === 'GB' ? 1073741824 : 1048576)) : 0;
    const hevc = q === '2160p' || /x265|hevc|h\.?265|10.?bit|hdr|dolby.?vision|\bdv\b/i.test(text);
    const heavy = /dts|truehd|atmos|e-?ac-?3|ddp/i.test(text);
    items.push({ s, q, seeds, size, hevc, heavy });
  }
  if (!items.length) return null;
  let pool = [i => !i.hevc && !i.heavy, i => !i.hevc, () => true].map(f => items.filter(f)).find(l => l.length);
  pool.sort((a, b) => b.seeds - a.seeds);
  const { s, q, seeds, size } = pool[0];
  const trackers = [...new Set([...TRACKERS, ...(s.sources || []).filter(x => String(x).startsWith('tracker:')).map(x => x.slice(8))])];
  const name = String(s.title || title).split('\n')[0] + (q ? ` [${q}]` : '');
  const magnet = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(name)}` + trackers.map(x => '&tr=' + encodeURIComponent(x)).join('');
  return { magnet, name, seeders: seeds, size, hash: s.infoHash };
}
const app = new Hono();
const hits = new Map();
const limited = (c, key, max) => {
  const ip = (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unknown', k = key + ip, now = Date.now();
  const list = (hits.get(k) || []).filter(t => now - t < 60000);
  if (list.length >= max) { hits.set(k, list); return true; }
  list.push(now); hits.set(k, list); if (hits.size > 5000) hits.clear();
  return false;
};
const magnetSig = hash => createHmac('sha256', SIGNING_SECRET).update('magnet:' + String(hash).toLowerCase()).digest('hex');
const isAdmin = c => equal(c.req.header('authorization') || '', 'Bearer ' + ADMIN_TOKEN);
const fromSite = c => c.req.header('origin') === ALLOWED_ORIGIN;
let streaming = 0;
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
  if (!fromSite(c) && !isAdmin(c)) return c.json({ error: 'Forbidden' }, 403);
  if (limited(c, 'search:', 20)) return c.json({ error: 'Too many requests' }, 429);
  let title, year, quality, lang, imdb;
  try {
    const body = await c.req.json();
    title = String(body.title || '').trim();
    year = String(body.year || '').trim();
    quality = String(body.quality || '').trim();
    lang = body.lang === 'ru' ? 'ru' : 'orig';
    imdb = /^tt\d{5,10}$/.test(String(body.imdb || '')) ? String(body.imdb) : '';
    if (quality && !['720p', '1080p', '2160p'].includes(quality)) throw new Error();
    if (!title) throw new Error();
  } catch { return c.json({ error: 'Expected a movie title' }, 400); }
  try {
    let best = null;
    if (lang === 'orig') { try { best = await searchYts(title, year, quality); } catch (e) { console.error('YTS:', e?.message || e); } }
    if (!best) { try { best = await searchTorrentio(title, year, quality, lang, imdb); } catch (e) { console.error('Torrentio:', e?.message || e); if (lang === 'ru') return c.json({ error: 'Torrent search failed' }, 502); } }
    if (!best) return c.json({ error: 'Source not found' }, 404);
    return c.json({ magnet: best.magnet, name: best.name, seeders: best.seeders, size: best.size, sig: magnetSig(best.hash) });
  } catch { return c.json({ error: 'Torrent search failed' }, 502); }
});
app.use('/api/torrent/stream', bodyLimit({ maxSize: 4096 }));
app.post('/api/torrent/stream', async c => {
  let magnet, sig, lang = 'orig';
  try {
    const body = await c.req.json();
    magnet = String(body.magnet || ''); sig = String(body.sig || ''); lang = body.lang === 'ru' ? 'ru' : 'orig';
    if (!magnet.startsWith('magnet:?xt=urn:btih:')) throw new Error();
  } catch { return c.json({ error: 'Expected a magnet link' }, 400); }
  const admin = isAdmin(c);
  if (!admin) {
    const h = new URL(magnet).searchParams.get('xt')?.replace('urn:btih:', '') || '';
    if (!fromSite(c) || !sig || !equal(sig, magnetSig(h))) return c.json({ error: 'Forbidden' }, 403);
    if (limited(c, 'stream:', 6)) return c.json({ error: 'Too many requests' }, 429);
    if (streaming >= 3) return c.json({ error: 'Busy, retry later' }, 429);
  }
  streaming++;
  const ts = (path, body, ms = 20000) => fetch(`${TORRSERVER_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const hash = new URL(magnet).searchParams.get('xt')?.replace('urn:btih:', '');
    if (!hash) throw new Error('Invalid magnet hash');
    const started = Date.now();
    // wake up TorrServer (free Render sleeps) and add the torrent
    let added = false, lastErr = '';
    while (!added && Date.now() - started < 70000) {
      try {
        const r = await ts('/torrents', { action: 'add', link: magnet, title: 'Torrent', save_to_db: false }, 25000);
        if (r.ok) added = true; else lastErr = 'add HTTP ' + r.status;
      } catch (e) { lastErr = 'add ' + (e?.message || e); }
      if (!added) await sleep(3000);
    }
    if (!added) { console.error('TorrServer unavailable:', lastErr); return c.json({ error: 'TorrServer is waking up, retry in a minute' }, 503); }
    while (Date.now() - started < 85000) {
      try {
        const r = await ts('/torrents', { action: 'get', hash }, 10000);
        if (r.ok) {
          const st = await r.json();
          if (st.stat_string === 'Torrent working' || (st.file_stats && st.file_stats.length)) {
            const files = (st.file_stats || []).filter(f => /\.(mp4|m4v|webm|mkv|avi|mov)$/i.test(f.path || ''));
            const main = files.sort((x, y) => (y.length || 0) - (x.length || 0))[0] || st.file_stats?.[0];
            const index = main?.id || 1;
            const base = process.env.RENDER_EXTERNAL_URL || new URL(c.req.url).origin;
            const payload = Buffer.from(JSON.stringify({ m: magnet, i: Number(index), lang, exp: Math.floor(Date.now() / 1000) + 14400 })).toString('base64url');
            return c.json({ streamUrl: `${base.replace(/\/$/, '')}/hls/${payload}.${hlsSign(payload)}/index.m3u8` });
          }
        } else console.error('TorrServer get HTTP', r.status);
      } catch (e) { console.error('TorrServer get error:', e?.message || e); }
      await sleep(3000);
    }
    console.error('TorrServer: no peers/metadata in time');
    return c.json({ error: 'No peers yet, try again or another title' }, 504);
  } catch (e) { console.error('stream failed:', e?.message || e); return c.json({ error: 'TorrServer stream failed' }, 502); }
  finally { streaming--; }
});
/* MKV/любой контейнер -> фрагментированный MP4 на лету: видео без перекодирования, звук в AAC */
let remuxing = 0;
const probeCache = new Map();
const probeAudio = (src, wantRu) => new Promise(resolve => {
  execFile('ffprobe', ['-v', 'error', '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-analyzeduration', '8000000', '-probesize', '8000000', '-show_entries', 'stream=index,codec_type,codec_name,profile,pix_fmt,width,height:stream_tags=language,title', '-of', 'json', src], { timeout: 25000 }, (err, out) => {
    if (err) { console.error('ffprobe:', err.message); return resolve(null); }
    try {
      const all = JSON.parse(out).streams || [];
      console.log('probe', JSON.stringify(all.map(s => [s.codec_type, s.codec_name, s.profile, s.pix_fmt, s.height, s.tags?.language].filter(Boolean).join('/'))));
      const a = all.filter(s => s.codec_type === 'audio');
      const i = wantRu ? a.findIndex(s => /^(rus|ru)$/i.test(s.tags?.language || '') || RU_RE.test(s.tags?.title || '')) : -1;
      resolve(i >= 0 ? i : null);
    } catch { resolve(null); }
  });
});
const HLS_ROOT = join(tmpdir(), 'watch-hls');
const sessions = new Map();
const hlsMime = f => f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : f.endsWith('.m4s') ? 'video/iso.segment' : 'video/mp4';
const hlsSign = payload => createHmac('sha256', SIGNING_SECRET).update('hls:' + payload).digest('base64url');
const stopSession = (key, why) => {
  const s = sessions.get(key); if (!s) return;
  sessions.delete(key); try { s.ff?.kill('SIGKILL'); } catch {}
  rm(s.dir, { recursive: true, force: true }).catch(() => {});
  console.log('hls stop', why);
};
setInterval(() => { const now = Date.now(); for (const [k, s] of sessions) if (now - s.last > 10 * 60 * 1000 || now - s.started > 6 * 3600 * 1000) stopSession(k, 'idle'); }, 60000).unref();
rm(HLS_ROOT, { recursive: true, force: true }).catch(() => {});
async function startSession(key, p) {
  if (sessions.size >= 2) { const old = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0]; stopSession(old[0], 'evicted'); }
  const dir = join(HLS_ROOT, randomBytes(8).toString('hex'));
  const s = { dir, last: Date.now(), started: Date.now(), ff: null };
  sessions.set(key, s);
  await mkdir(dir, { recursive: true });
  const src = `${TORRSERVER_URL}/stream?link=${encodeURIComponent(p.m)}&play=true&index=${p.i}`;
  const audio = await probeAudio(src, p.lang === 'ru');
  if (!sessions.has(key)) return s;
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-analyzeduration', '8000000', '-probesize', '8000000', '-fflags', '+genpts', '-readrate', '4',
    '-i', src,
    '-map', '0:v:0', '-map', `0:a:${audio ?? 0}?`,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-sn', '-dn', '-map_chapters', '-1', '-avoid_negative_ts', 'make_zero',
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'seg%d.m4s'), '-hls_flags', 'independent_segments+temp_file',
    join(dir, 'index.m3u8')];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  s.ff = ff; let log = '';
  ff.stderr.on('data', d => { if (log.length < 3000) log += d; });
  ff.on('close', (code, sig) => { console.log('hls ffmpeg end', 'code=' + code, 'signal=' + sig); if (log) console.error('ffmpeg:', log.trim()); s.done = true; });
  ff.on('error', e => console.error('ffmpeg spawn:', e?.message || e));
  console.log('hls start', 'index=' + p.i, 'audio=' + (audio ?? 'default'));
  return s;
}
app.get('/hls/:tok/:file', async c => {
  const { tok, file } = c.req.param();
  const [payload, sig] = tok.split('.');
  if (!payload || !sig || !equal(sig, hlsSign(payload)) || !/^(index\.m3u8|init\.mp4|seg\d+\.m4s)$/.test(file)) return c.json({ error: 'Invalid video link' }, 403);
  let p;
  try { p = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return c.json({ error: 'Invalid video link' }, 403); }
  if (!(p.exp > Date.now() / 1000) || !String(p.m).startsWith('magnet:?xt=urn:btih:') || !Number.isInteger(p.i) || p.i < 1) return c.json({ error: 'Expired video link' }, 403);
  try {
    let s = sessions.get(payload);
    if (!s) s = await startSession(payload, p);
    s.last = Date.now();
    const path = join(s.dir, file), until = Date.now() + (file === 'index.m3u8' ? 90000 : 30000);
    while (!existsSync(path)) {
      if (s.done || !sessions.has(payload) || Date.now() > until) return c.json({ error: 'Not ready' }, 404);
      await new Promise(r => setTimeout(r, 300));
    }
    const buf = await readFile(path);
    return new Response(buf, { status: 200, headers: { 'Content-Type': hlsMime(file), 'Cache-Control': 'no-store' } });
  } catch (e) { console.error('hls failed:', e?.message || e); return c.json({ error: 'HLS failed' }, 502); }
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
/* KEEPALIVE=1: не даёт бесплатному Render усыплять бэкенд и TorrServer (пинг раз в 9 минут) */
if (process.env.KEEPALIVE === '1') {
  const self = process.env.RENDER_EXTERNAL_URL;
  setInterval(() => {
    if (self) fetch(self + '/health', { signal: AbortSignal.timeout(20000) }).catch(() => {});
    fetch(TORRSERVER_URL + '/echo', { signal: AbortSignal.timeout(20000) }).catch(() => {});
  }, 9 * 60 * 1000);
}
serve({ fetch: app.fetch, hostname: '0.0.0.0', port: Number(process.env.PORT || 10000) });
