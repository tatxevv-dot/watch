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
if [ "$ready" != true ]; then
  echo '{"result":"server_not_started"}'
  tail -n 50 "$server_log"
  exit 2
fi
curl -fsS --max-time 120 'http://127.0.0.1:4000/api/v1/extract?tmdb_id=533535&type=movie' > /tmp/aryx-extract.json
python3 - <<'PY'
import json, subprocess
from pathlib import Path
extract = json.loads(Path('/tmp/aryx-extract.json').read_text())
urls = []
for result in extract.get('results', {}).values():
    if result.get('hls_url'):
        urls.append(result['hls_url'])
results = []
for url in urls[:3]:
    probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'http,https,tcp,tls,crypto,data', '-headers', 'User-Agent: Mozilla/5.0\r\n', '-i', url, '-show_streams', '-of', 'json'], capture_output=True, text=True, timeout=45)
    info = {}
    try: info = json.loads(probe.stdout or '{}')
    except Exception: pass
    tracks = []
    for stream in (info.get('streams') or []):
        if stream.get('codec_type') != 'audio': continue
        tags = stream.get('tags') or {}
        language = str(tags.get('language') or '').lower()
        title = str(tags.get('title') or '')
        russian = language in ('ru', 'rus', 'ru-ru') or 'russian' in (language + ' ' + title).lower() or 'дубляж' in title.lower()
        decode = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'http,https,tcp,tls,crypto,data', '-headers', 'User-Agent: Mozilla/5.0\r\n', '-i', url, '-map', '0:' + str(stream.get('index', 0)), '-t', '10', '-vn', '-sn', '-dn', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], capture_output=True, text=True, timeout=45)
        seconds = max([float(x) for x in __import__('re').findall(r'out_time_us=(\d+)', decode.stdout or '')] or [0]) / 1000000
        tracks.append({'index': stream.get('index'), 'codec': stream.get('codec_name'), 'channels': stream.get('channels'), 'language': language, 'title': title[:80], 'decodedSeconds': seconds, 'decoded': decode.returncode == 0 and seconds >= 1, 'russianLanguageTag': russian})
    results.append({'hlsUrlFound': True, 'audioTracks': tracks, 'probeSucceeded': probe.returncode == 0})
russian = any(t.get('russianLanguageTag') and t.get('decoded') for r in results for t in r.get('audioTracks', []))
report = {'candidate': 'AryxK6/aryx-m3u8-scraper', 'testedFrom': 'GitHub Actions, not Render', 'tmdbId': 533535, 'streamsTested': len(results), 'russianTaggedAudioDecoded': russian, 'results': results, 'limitations': ['Language metadata is not independent speech recognition', 'Not browser playback', 'Render access not verified', 'Content permissions not verified']}
print(json.dumps(report, indent=2))
Path('/tmp/aryx-audio-report.json').write_text(json.dumps(report, indent=2) + '\n')
PY
exit 0
