export function tmdbInput({ type, tmdbId, season, episode }) {
  const valid = n => Number.isSafeInteger(Number(n)) && Number(n) > 0;
  if (!valid(tmdbId)) throw new Error('Invalid TMDB ID');
  if (type === 'movie') return `https://www.themoviedb.org/movie/${Number(tmdbId)}`;
  if (type !== 'tv' || !valid(season) || !valid(episode)) throw new Error('Invalid episode');
  return `https://www.themoviedb.org/tv/${Number(tmdbId)}/season/${Number(season)}/episode/${Number(episode)}`;
}

export async function loadNxshaSources(media, { endpoint, fetcher = globalThis.fetch, signal } = {}) {
  if (!endpoint) throw new Error('Nxsha backend endpoint is not configured');
  const api = new URL(endpoint);
  if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname))) throw new Error('HTTPS backend required');
  if (api.username || api.password) throw new Error('Credentials in endpoint URL are not allowed');
  const response = await fetcher(api.href, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: tmdbInput(media) }),
    signal: signal || AbortSignal.timeout(45000), credentials: 'same-origin'
  });
  if (!response.ok) throw new Error(`Nxsha backend HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.servers)) throw new Error('Nxsha backend returned no server list');
  const sources = data.servers.flatMap((server, index) => {
    if (!server || !['mp4', 'm3u8'].includes(server.type) || typeof server.proxyUrl !== 'string') return [];
    let url;
    try { url = new URL(server.proxyUrl, api); } catch { return []; }
    if (url.origin !== api.origin || url.username || url.password) return [];
    return [{ id: `nxsha-${index}`, provider: 'nxsha', title: String(server.name || 'Nxsha'), quality: String(server.quality || ''), type: server.type, url: url.href }];
  });
  if (!sources.length) throw new Error('Nxsha returned no supported video sources');
  return sources;
}
