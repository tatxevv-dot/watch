#!/usr/bin/env bash
set -uo pipefail
cd /app
server_log=/tmp/aryx-server.log
node server.js >"$server_log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
ready=false
for attempt in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:4000/api/v1/health > /tmp/aryx-health.json 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
extract_status=1
if [ "$ready" = true ]; then
  curl -fsS --max-time 120 'http://127.0.0.1:4000/api/v1/extract?tmdb_id=533535&type=movie' > /tmp/aryx-extract.json 2>/dev/null
  extract_status=$?
fi
printf '%s' "$extract_status" > /tmp/aryx-extract-status
TMDB_API_KEY="${TMDB_API_KEY:-}" TMDB_BEARER_TOKEN="${TMDB_BEARER_TOKEN:-}" python3 - <<'PY'
import json, os
from pathlib import Path
health = {}
try: health = json.loads(Path('/tmp/aryx-health.json').read_text())
except Exception: pass
extract = {}
try: extract = json.loads(Path('/tmp/aryx-extract.json').read_text())
except Exception: pass
try: extract_status = int(Path('/tmp/aryx-extract-status').read_text().strip())
except Exception: extract_status = 1
server_error = ''
try: server_error = Path('/tmp/aryx-server.log').read_text(errors='replace')[-4000:]
except Exception: pass
results = extract.get('results', {})
found = []
for provider, result in results.items():
    if result.get('hls_url'):
        found.append({'provider': provider, 'hlsUrlFound': True, 'error': result.get('error')})
report = {
  'candidate': 'AryxK6/aryx-m3u8-scraper',
  'testedFrom': 'GitHub Actions, not Render',
  'tmdbId': 533535,
  'serverStarted': health.get('data', {}).get('status') == 'healthy',
  'tmdbKeyPresent': bool(os.environ.get('TMDB_API_KEY')),
  'tmdbBearerPresent': bool(os.environ.get('TMDB_BEARER_TOKEN')),
  'providersQueried': extract.get('meta', {}).get('providers_queried', 0),
  'hlsUrlsFound': len(found),
  'found': found,
  'extractStatus': extract_status,
  'serverError': server_error,
  'limitations': ['HLS URL discovery only', 'Not audio or playback verification', 'Render access not verified', 'Content permissions not verified']
}
Path('/tmp/aryx-report.json').write_text(json.dumps(report, indent=2) + '\n')
PY
exit 0
