console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
try {
  const { PROVIDERS, scrapeAll } = await import('/app/src/providers.js');
  const ids = ['cinesrc', 'vixsrc', 'twoembed'];
  const tasks = PROVIDERS.filter(p => ids.includes(p.id));
  if (tasks.length !== ids.length) throw new Error('Expected provider set not found');
  const streams = await scrapeAll('movie', '533535', undefined, undefined, tasks);
  if (!streams.length) {
    process.stdout.write(JSON.stringify({ result: 'no_streams_found', audioTracks: [] }) + '\n');
    process.exit(2);
  }
  const audioTracks = [];
  for (const stream of streams.slice(0, 5)) {
    if (stream.type !== 'hls') continue;
    const response = await fetch(stream.url, {
      headers: { 'User-Agent': UA, Referer: new URL(stream.url).origin + '/' },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) continue;
    const playlist = await response.text();
    if (!playlist.trimStart().startsWith('#EXTM3U')) continue;
    const variantLines = playlist.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
    const variants = variantLines.length ? variantLines : [stream.url];
    for (const variant of variants.slice(0, 3)) {
      const mediaUrl = new URL(variant, stream.url).href;
      const mediaResponse = await fetch(mediaUrl, {
        headers: { 'User-Agent': UA, Referer: new URL(stream.url).origin + '/' },
        signal: AbortSignal.timeout(10000)
      });
      if (!mediaResponse.ok) continue;
      const media = await mediaResponse.text();
      if (!media.trimStart().startsWith('#EXTM3U')) continue;
      const lines = media.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^#EXT-X-MEDIA:(.*)$/i);
        if (!match) continue;
        const attributes = match[1];
        const type = (attributes.match(/TYPE=([^,]+)/i) || [])[1] || '';
        if (!/audio/i.test(type)) continue;
        const language = (attributes.match(/LANGUAGE="([^"]*)"/i) || [])[1] || '';
        const name = (attributes.match(/NAME="([^"]*)"/i) || [])[1] || '';
        const channels = (attributes.match(/CHANNELS="([^"]*)"/i) || [])[1] || '';
        audioTracks.push({
          provider: String(stream.provider || '').replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 40),
          language: language.toLowerCase(),
          name: String(name).slice(0, 60),
          channels,
          russian: /(^|[,;])ru([,;]|$)|russian/i.test(language + ' ' + name)
        });
      }
    }
  }
  const russian = audioTracks.filter(t => t.russian);
  const report = {
    candidate: 'x8rr/movies',
    revision: 'bf57ffd029996b86cf86f7f16d919b4fb79e9bad',
    testedFrom: 'GitHub Actions, not Render',
    tmdbId: 533535,
    streamsInspected: Math.min(streams.length, 5),
    audioTracksFound: audioTracks.length,
    russianAudioTracks: russian.length,
    russianTracks: russian.map(t => ({ provider: t.provider, language: t.language, name: t.name, channels: t.channels })),
    allAudioTracks: audioTracks.map(t => ({ provider: t.provider, language: t.language, name: t.name, channels: t.channels })),
    limitations: ['Metadata inspection only', 'Not a full playback test', 'Render access not verified', 'Content permissions not verified']
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(russian.length ? 0 : 2);
} catch {
  process.stdout.write(JSON.stringify({ error: 'Audio probe execution failed; no audio tracks verified' }) + '\n');
  process.exit(1);
}
