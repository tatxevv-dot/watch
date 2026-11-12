import test from 'node:test';
import assert from 'node:assert/strict';
import { tmdbInput, loadNxshaSources } from '../src/nxsha-client.mjs';
const media = { type: 'movie', tmdbId: 123 };
const endpoint = 'https://backend.example/api/extract';
test('movie and episode addressing', () => {
  assert.equal(tmdbInput(media), 'https://www.themoviedb.org/movie/123');
  assert.equal(tmdbInput({ type: 'tv', tmdbId: 123, season: 2, episode: 3 }), 'https://www.themoviedb.org/tv/123/season/2/episode/3');
  assert.throws(() => tmdbInput({ ...media, tmdbId: -1 }));
  assert.throws(() => tmdbInput({ type: 'tv', tmdbId: 123, season: 0, episode: 1 }));
});
test('normalizes supported proxy sources and rejects foreign origins', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, endpoint);
    assert.deepEqual(JSON.parse(options.body), { url: tmdbInput(media) });
    return { ok: true, json: async () => ({ servers: [
      { name: 'NX', type: 'mp4', quality: '1080p', proxyUrl: '/proxy?url=example' },
      { name: 'Foreign', type: 'm3u8', proxyUrl: 'https://other.example/video' },
      { name: 'Embed', type: 'iframe', proxyUrl: '/embed' }
    ] }) };
  };
  const sources = await loadNxshaSources(media, { endpoint, fetcher });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://backend.example/proxy?url=example');
  assert.equal(sources[0].type, 'mp4');
});
test('reports backend failure and empty results', async () => {
  await assert.rejects(loadNxshaSources(media, { endpoint, fetcher: async () => ({ ok: false, status: 502 }) }), /502/);
  await assert.rejects(loadNxshaSources(media, { endpoint, fetcher: async () => ({ ok: true, json: async () => ({ servers: [] }) }) }), /no supported/);
  await assert.rejects(loadNxshaSources(media), /not configured/);
});
