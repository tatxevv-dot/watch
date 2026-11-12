console.log = console.info = console.warn = console.error = () => {};
const { spawnSync } = await import('node:child_process');
const safe = v => String(v || '').replace(/https?:\/\/\S+/gi, '[URL]').replace(/[\r\n]/g, ' ').slice(0, 100);
const ru = v => /^(ru|rus|ru-ru)$/i.test(String(v || '').trim());
const run = (bin, args) => spawnSync(bin, args, { timeout: 30000, maxBuffer: 1048576, encoding: 'utf8' });
try {
  const { PROVIDERS, scrapeAll } = await import('/app/src/providers.js');
  const streams = await scrapeAll('movie', '533535', undefined, undefined, PROVIDERS.filter(p => ['cinesrc', 'vixsrc', 'twoembed'].includes(p.id)));
  const results = [];
  for (const s of streams.filter(s => s.type === 'hls').slice(0, 5)) {
    const h = { 'User-Agent': 'Mozilla/5.0', Referer: new URL(s.url).origin + '/', ...(s.headers || {}) };
    const headers = Object.entries(h).filter(([k, v]) => typeof v === 'string' && !/[\r\n]/.test(k + v)).map(([k, v]) => k + ': ' + v + '\r\n').join('');
    const input = ['-protocol_whitelist', 'http,https,tcp,tls,crypto,data', '-rw_timeout', '8000000', '-headers', headers, '-probesize', '2000000', '-analyzeduration', '5000000'];
    const p = run('ffprobe', ['-v', 'error', ...input, '-i', s.url, '-show_streams', '-of', 'json']);
    let info;
    try { info = JSON.parse(p.stdout || '{}'); } catch { info = {}; }
    const tracks = (info.streams || []).filter(t => t.codec_type === 'audio');
    const result = { provider: safe(s.provider), probeSucceeded: p.status === 0, audioTracks: [], limitation: 'Language tags describe metadata, not independent speech recognition' };
    for (let i = 0; i < Math.min(tracks.length, 8); i++) {
      const t = tracks[i];
      const d = run('ffmpeg', ['-nostdin', '-v', 'error', ...input, '-i', s.url, '-map', '0:' + t.index, '-t', '5', '-vn', '-sn', '-dn', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']);
      const progress = [...String(d.stdout || '').matchAll(/out_time_us=(\d+)/g)].map(m => Number(m[1]));
      const seconds = Math.max(0, ...progress) / 1000000;
      result.audioTracks.push({ index: t.index, codec: safe(t.codec_name), channels: t.channels || null, language: safe(t.tags?.language), title: safe(t.tags?.title), decodedSeconds: seconds, decoded: d.status === 0 && seconds >= 1, russianLanguageTag: ru(t.tags?.language) });
    }
    results.push(result);
  }
  const confirmed = results.some(r => r.audioTracks.some(t => t.decoded && t.russianLanguageTag));
  process.stdout.write(JSON.stringify({ candidate: 'x8rr/movies', testedFrom: 'GitHub Actions, not Render', tmdbId: 533535, russianTaggedAudioDecoded: confirmed, nextStep: confirmed ? 'Review browser and Render compatibility separately' : 'Switch to AryxK6/aryx-m3u8-scraper; no more tests of this candidate', results, limitations: ['Not browser playback', 'No independent verification of spoken language', 'No Render or content-permission verification'] }, null, 2) + '\n');
  process.exit(confirmed ? 0 : 2);
} catch {
  process.stdout.write(JSON.stringify({ result: 'inconclusive', nextStep: 'Switch to AryxK6/aryx-m3u8-scraper' }) + '\n');
  process.exit(2);
}
