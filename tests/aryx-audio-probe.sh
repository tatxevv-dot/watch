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
python3 /app/aryx-audio-report.py
exit 0
