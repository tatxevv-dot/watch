#!/usr/bin/env bash
set -uo pipefail
cd /app
server_log=/tmp/aryx-server.log
node server.js >"$server_log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
ready=false
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/v1/health >/tmp/aryx-health.json 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
health='{"serverStarted":'$ready'}'
if [ "$ready" != true ]; then
  printf '%s\n' "$health" > /tmp/aryx-report.json
  tail -n 40 "$server_log" > /tmp/aryx-error.log
  exit 2
fi
curl -fsS --max-time 90 'http://127.0.0.1:4000/api/v1/extract?tmdb_id=533535&type=movie' > /tmp/aryx-extract.json
python3 - <<'PY'
import json
from pathlib import Path
health = json.loads(Path('/tmp/aryx-health.json').read_text())
extract = json.loads(Path('/tmp/aryx-extract.json').read_text())
results = extract.get('results', {})
found = []
for provider, result in results.items():
    hls = result.get('hls_url')
    if hls:
        found.append({'provider': provider, 'hlsUrlFound': True, 'error': result.get('error')})
report = {
  'candidate': 'AryxK6/aryx-m3u8-scraper',
  'testedFrom': 'GitHub Actions, not Render',
  'tmdbId': 533535,
  'serverStarted': bool(health.get('data', {}).get('status') == 'healthy'),
  'providersQueried': extract.get('meta', {}).get('providers_queried', 0),
  'hlsUrlsFound': len(found),
  'found': found,
  'limitations': ['HLS URL discovery only', 'Not audio or playback verification', 'Render access not verified', 'Content permissions not verified']
}
Path('/tmp/aryx-report.json').write_text(json.dumps(report, indent=2) + '\n')
PY
exit 0
