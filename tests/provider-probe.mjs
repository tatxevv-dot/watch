console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};
try {
  const { PROVIDERS, scrapeAll } = await import('/app/src/providers.js');
  const ids = ['cinesrc', 'vixsrc', 'twoembed'];
  const tasks = PROVIDERS.filter(p => ids.includes(p.id));
  if (tasks.length !== ids.length) throw new Error('Expected provider set not found');
  const started = Date.now();
  const streams = await scrapeAll('movie', '533535', undefined, undefined, tasks);
  const safe = value => String(value || '').replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 80);
  const report = {
    candidate: 'x8rr/movies',
    revision: 'bf57ffd029996b86cf86f7f16d919b4fb79e9bad',
    testedFrom: 'GitHub Actions, not Render',
    tmdbId: 533535,
    testedProviders: ids,
    reachableStreams: streams.length,
    durationMs: Date.now() - started,
    streams: streams.map(s => ({ provider: safe(s.provider), type: safe(s.type), quality: safe(s.quality) })),
    limitations: ['Not a playback test', 'Audio languages not verified', 'Render access not verified', 'Content permissions not verified']
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(streams.length ? 0 : 2);
} catch {
  process.stdout.write(JSON.stringify({ error: 'Probe execution failed; no sources verified' }) + '\n');
  process.exit(1);
}
