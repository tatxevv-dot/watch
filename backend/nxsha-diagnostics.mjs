import { extract as upstreamExtract } from './nxsha-upstream.js';
function redacted(value) {
  let text = String(value || 'Unknown error');
  for (const secret of [process.env.ADMIN_TOKEN, process.env.SIGNING_SECRET]) {
    if (secret) text = text.split(secret).join('[SECRET]');
  }
  return text.replace(/https?:\/\/\S+/gi, '[URL]').replace(/[\r\n]/g, ' ').slice(0, 400);
}
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async function(input, options) {
  const response = await originalFetch(input, options);
  if (!response.ok) {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://web.nxsha.app' && ['/api/servers', '/api/sources'].includes(url.pathname)) {
        console.error('[nxsha] ' + JSON.stringify({
          event: 'upstream_denial_headers', path: url.pathname, status: response.status,
          contentType: redacted(response.headers.get('content-type') || 'absent'),
          server: redacted(response.headers.get('server') || 'absent'),
          cloudflareRayPresent: response.headers.has('cf-ray'),
          challengeIndicated: response.headers.get('cf-mitigated') === 'challenge',
          authenticateHeaderPresent: response.headers.has('www-authenticate')
        }));
      }
    } catch { /* Diagnostics must not change the upstream response. */ }
  }
  return response;
};
export async function extract(...args) {
  const started = Date.now();
  console.info('[nxsha] extraction_started');
  try {
    const result = await upstreamExtract(...args);
    console.info('[nxsha] ' + JSON.stringify({ event: 'extraction_succeeded', servers: Array.isArray(result.servers) ? result.servers.length : 0, durationMs: Date.now() - started }));
    return result;
  } catch (error) {
    const message = redacted(error?.message || error);
    const http = message.match(/HTTP\s+(\d{3})/i);
    const category = http ? 'upstream_http_' + http[1] : /no servers/i.test(message) ? 'no_servers' : /no playable/i.test(message) ? 'no_playable_sources' : /fetch failed/i.test(message) ? 'network_error' : /JSON|UTF-8/i.test(message) ? 'response_decode_error' : 'extractor_error';
    console.error('[nxsha] ' + JSON.stringify({ event: 'extraction_failed', category, message, cause: error?.cause?.code ? redacted(error.cause.code) : null, durationMs: Date.now() - started }));
    throw error;
  }
}
