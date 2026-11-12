import { extract as upstreamExtract } from './nxsha-upstream.js';
function redacted(value) {
  let text = String(value || 'Unknown error');
  for (const secret of [process.env.ADMIN_TOKEN, process.env.SIGNING_SECRET]) {
    if (secret) text = text.split(secret).join('[SECRET]');
  }
  return text.replace(/https?:\/\/\S+/gi, '[URL]').replace(/[\r\n]/g, ' ').slice(0, 400);
}
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
