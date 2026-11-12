console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_SEGMENTS = 2;
const MAX_BYTES_PER_SEGMENT = 262144;
async function readPlaylist(url, referer) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('not HLS playlist');
  return text;
}
function selectVariant(playlist, baseUrl) {
  const lines = playlist.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
    const attributes = lines[i].replace(/^#EXT-X-STREAM-INF:/i, '');
    const bandwidth = Number((attributes.match(/BANDWIDTH=(\d+)/i) || [])[1] || 0);
    const resolution = (attributes.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || '';
    const target = lines[i + 1];
    if (target && target.trim() && !target.startsWith('#')) {
      variants.push({ bandwidth, resolution, url: new URL(target.trim(), baseUrl).href });
    }
  }
  if (!variants.length) return { url: baseUrl, bandwidth: 0, resolution: '' };
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants[0];
}
async function inspectVariant(url, referer) {
  const playlist = await readPlaylist(url, referer);
  const segmentLines = playlist.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).slice(0, MAX_SEGMENTS);
  if (!segmentLines.length) return { playable: false, reason: 'no media segments', audioTracks: [] };
  const audioTracks = [];
  for (const line of playlist.split(/\r?\n/)) {
    const match = line.match(/^#EXT-X-MEDIA:(.*)$/i);
    if (!match) continue;
    const attrs = match[1];
    if (!/TYPE=AUDIO/i.test(attrs)) continue;
    audioTracks.push({
      language: ((attrs.match(/LANGUAGE="([^"]*)"/i) || [])[1] || '').toLowerCase(),
      name: ((attrs.match(/NAME="([^"]*)"/i) || [])[1] || '').slice(0, 60),
      channels: ((attrs.match(/CHANNELS="([^"]*)"/i) || [])[1] || '')
    });
  }
  const segment = new URL(segmentLines[0], url).href;
  const response = await fetch(segment, {
    headers: { 'User-Agent': UA, Referer: referer },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) return { playable: false, reason: `segment HTTP ${response.status}`, audioTracks };
  const reader = response.body?.getReader();
  if (!reader) return { playable: false, reason: 'segment body unavailable', audioTracks };
  let bytes = 0;
  let firstChunk;
  while (bytes < MAX_BYTES_PER_SEGMENT) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!firstChunk) firstChunk = chunk.value;
    bytes += chunk.value.length;
  }
  await reader.cancel();
  if (!firstChunk || !bytes) return { playable: false, reason: 'empty segment', audioTracks };
  const head = Buffer.from(firstChunk.slice(0, 16));
  const isMpegTs = head[0] === 0x47;
  const isMp4 = head.subarray(4, 8).toString('ascii') === 'ftyp';
  const isAdts = head[0] === 0xff && (head[1] & 0xf0) === 0xf0;
  return {
    playable: isMpegTs || isMp4 || isAdts,
    reason: isMpegTs ? 'MPEG-TS segment' : isMp4 ? 'MP4 segment' : isAdts ? 'ADTS audio segment' : 'unrecognized media format',
    bytesFetched: bytes,
    audioTracks
  };
}
try {
  const { PROVIDERS, scrapeAll } = await import('/app/src/providers.js');
  const ids = ['cinesrc', 'vixsrc', 'twoembed'];
  const tasks = PROVIDERS.filter(p => ids.includes(p.id));
  if (tasks.length !== ids.length) throw new Error('Expected provider set not found');
  const streams = await scrapeAll('movie', '533535', undefined, undefined, tasks);
  if (!streams.length) {
    process.stdout.write(JSON.stringify({ result: 'no_streams_found', playbackResults: [] }) + '\n');
    process.exit(2);
  }
  const playbackResults = [];
  for (const stream of streams.slice(0, 5)) {
    if (stream.type !== 'hls') continue;
    const referer = new URL(stream.url).origin + '/';
    try {
      const playlist = await readPlaylist(stream.url, referer);
      const variant = selectVariant(playlist, stream.url);
      const inspection = await inspectVariant(variant.url, referer);
      playbackResults.push({
        provider: String(stream.provider || '').replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 40),
        variantResolution: variant.resolution,
        variantBandwidth: variant.bandwidth,
        playable: inspection.playable,
        reason: inspection.reason,
        bytesFetched: inspection.bytesFetched || 0,
        audioTracks: inspection.audioTracks
      });
    } catch (error) {
      playbackResults.push({
        provider: String(stream.provider || '').replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 40),
        playable: false,
        reason: String(error.message || error).slice(0, 100),
        audioTracks: []
      });
    }
  }
  const playable = playbackResults.filter(r => r.playable);
  const report = {
    candidate: 'x8rr/movies',
    revision: 'bf57ffd029996b86cf86f7f16d919b4fb79e9bad',
    testedFrom: 'GitHub Actions, not Render',
    tmdbId: 533535,
    streamsInspected: Math.min(streams.length, 5),
    playableStreams: playable.length,
    playbackResults,
    limitations: ['Limited first segments only', 'Not a full movie playback test', 'Render access not verified', 'Content permissions not verified']
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(playable.length ? 0 : 2);
} catch {
  process.stdout.write(JSON.stringify({ error: 'Playback probe execution failed; no playable stream verified' }) + '\n');
  process.exit(1);
}
