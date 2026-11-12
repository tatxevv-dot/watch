console.log = console.info = console.warn = console.error = () => {};
const { spawnSync } = await import('node:child_process');
const safe = v => String(v || '').replace(/https?:\/\/\S+/gi, '[URL]').replace(/[\r\n]/g, ' ').slice(0, 120);
const run = (bin, args) => spawnSync(bin, args, { timeout: 45000, maxBuffer: 2097152, encoding: 'utf8' });
const isRussian = (language, title) => {
  const text = String(language || '') + ' ' + String(title || '');
  return /(^|[,;\s])(ru|rus|ru-ru)([,;\s]|$)|russian|дубляж|закадр|многоголос/i.test(text);
};
try {
  const { PROVIDERS, scrapeAll } = await import('/app/src/providers.js');
  const streams = await scrapeAll('movie', '533535', undefined, undefined, PROVIDERS.filter(p => ['cinesrc', 'vixsrc', 'twoembed'].includes(p.id)));
  const results = [];
  for (const stream of streams.filter(s => s.type === 'hls')) {
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: new URL(stream.url).origin + '/', ...(stream.headers || {}) };
    const headerArgs = Object.entries(headers).filter(([k, v]) => typeof v === 'string' && !/[\r\n]/.test(k + v)).map(([k, v]) => k + ': ' + v + '\r\n').join('');
    const common = ['-protocol_whitelist', 'http,https,tcp,tls,crypto,data', '-rw_timeout', '10000000', '-headers', headerArgs, '-probesize', '5000000', '-analyzeduration', '10000000'];
    const probe = run('ffprobe', ['-v', 'error', ...common, '-i', stream.url, '-show_streams', '-show_format', '-of', 'json']);
    let info = {};
    try { info = JSON.parse(probe.stdout || '{}'); } catch {}
    const audioStreams = (info.streams || []).filter(t => t.codec_type === 'audio');
    const result = { provider: safe(stream.provider), probeSucceeded: probe.status === 0, audioTracks: [], embeddedAudioLikely: false, russianCandidates: [] };
    if (probe.status === 0 && audioStreams.length) {
      result.embeddedAudioLikely = audioStreams.some(t => t.disposition?.default || t.disposition?.attached_pic === 0);
      for (const track of audioStreams.slice(0, 10)) {
        const russian = isRussian(track.tags?.language, track.tags?.title);
        const decode = run('ffmpeg', ['-nostdin', '-v', 'error', ...common, '-i', stream.url, '-map', '0:' + track.index, '-t', '10', '-vn', '-sn', '-dn', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']);
        const progress = [...String(decode.stdout || '').matchAll(/out_time_us=(\d+)/g)].map(m => Number(m[1]));
        const seconds = Math.max(0, ...progress) / 1000000;
        const decoded = decode.status === 0 && seconds >= 1;
        const item = { index: track.index, codec: safe(track.codec_name), channels: track.channels || null, language: safe(track.tags?.language), title: safe(track.tags?.title), decodedSeconds: seconds, decoded, russianLanguageTag: russian };
        result.audioTracks.push(item);
        if (russian && decoded) result.russianCandidates.push(item);
      }
    }
    results.push(result);
  }
  const confirmed = results.some(r => r.russianCandidates.length > 0);
  const report = { candidate: 'x8rr/movies', testedFrom: 'GitHub Actions, not Render', tmdbId: 533535, streamsTested: results.length, russianTaggedAudioDecoded: confirmed, nextStep: confirmed ? 'Review browser and Render compatibility separately' : 'Switch to AryxK6/aryx-m3u8-scraper; no more tests of this candidate', results, limitations: ['Language metadata is not independent speech recognition', 'Not a browser playback test', 'Render access not verified', 'Content permissions not verified'] };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(confirmed ? 0 : 2);
} catch {
  process.stdout.write(JSON.stringify({ result: 'inconclusive', nextStep: 'Switch to AryxK6/aryx-m3u8-scraper' }) + '\n');
  process.exit(2);
}
