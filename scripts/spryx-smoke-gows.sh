#!/bin/sh
set -eu

image="${1:?usage: spryx-smoke-gows.sh IMAGE}"
container="${WAHA_SMOKE_CONTAINER:-spryx-waha-smoke-$$}"
port="${WAHA_SMOKE_PORT:-3301}"
api_key="${WAHA_SMOKE_API_KEY:-local-smoke-api-key}"
version_file="$(mktemp)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$version_file"
}
trap cleanup EXIT INT TERM

docker run -d --rm \
  --name "$container" \
  -p "127.0.0.1:${port}:3000" \
  -e "WAHA_API_KEY=${api_key}" \
  -e WAHA_DASHBOARD_USERNAME=local-admin \
  -e WAHA_DASHBOARD_PASSWORD=local-smoke-password \
  "$image" >/dev/null

attempt=0
while [ "$attempt" -lt 60 ]; do
  code="$(
    curl -sS -o "$version_file" -w '%{http_code}' \
      -H "X-Api-Key: ${api_key}" \
      "http://127.0.0.1:${port}/api/server/version" 2>/dev/null || true
  )"
  if [ "$code" = 200 ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$code" != 200 ]; then
  docker logs "$container"
  echo "WAHA did not become ready" >&2
  exit 1
fi

VERSION_FILE="$version_file" node <<'NODE'
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.env.VERSION_FILE, 'utf8'));
if (data.engine !== 'GOWS' || data.tier !== 'CORE') {
  throw new Error(`Unexpected runtime: ${JSON.stringify(data)}`);
}
if (!/^[0-9a-f]{40}$/.test(data.build?.revision ?? '')) {
  throw new Error(`Invalid build revision: ${JSON.stringify(data)}`);
}
if (!/^\d{4}\.\d+\.\d+$/.test(data.build?.version ?? '')) {
  throw new Error(`Invalid build version: ${JSON.stringify(data)}`);
}
if (data.build?.source !== 'https://github.com/Spryx-AI/waha') {
  throw new Error(`Missing immutable build metadata: ${JSON.stringify(data)}`);
}
NODE

unauthorized="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:${port}/api/sessions"
)"
if [ "$unauthorized" != 401 ]; then
  echo "Expected unauthenticated sessions request to return 401" >&2
  exit 1
fi

health="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -H "X-Api-Key: ${api_key}" \
    "http://127.0.0.1:${port}/health"
)"
if [ "$health" != 200 ]; then
  echo "Expected authenticated health request to return 200" >&2
  exit 1
fi

readiness="$(
  curl -fsS \
    -H "X-Api-Key: ${api_key}" \
    "http://127.0.0.1:${port}/health/ready"
)"
READINESS="$readiness" node <<'NODE'
const readiness = JSON.parse(process.env.READINESS);
const runtime = readiness.info?.['gows.runtime'];
if (readiness.status !== 'ok' || runtime?.status !== 'up') {
  throw new Error(`Unexpected GOWS readiness: ${JSON.stringify(readiness)}`);
}
if (
  runtime.worker?.ready !== true ||
  runtime.worker?.process?.status !== 'ready'
) {
  throw new Error(`GOWS worker is not ready: ${JSON.stringify(readiness)}`);
}
if (runtime.eventStreams?.status !== 'ready') {
  throw new Error(`Unexpected event-stream state: ${JSON.stringify(readiness)}`);
}
NODE

for session in smoke-one smoke-two; do
  curl -fsS -X POST \
    -H "X-Api-Key: ${api_key}" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"${session}\",\"start\":false}" \
    "http://127.0.0.1:${port}/api/sessions" >/dev/null
done

sessions="$(
  curl -fsS \
    -H "X-Api-Key: ${api_key}" \
    "http://127.0.0.1:${port}/api/sessions?all=true"
)"
SESSIONS="$sessions" node <<'NODE'
const sessions = JSON.parse(process.env.SESSIONS);
const names = sessions.map((session) => session.name).sort();
if (names.join(',') !== 'smoke-one,smoke-two') {
  throw new Error(`Unexpected sessions: ${JSON.stringify(sessions)}`);
}
NODE

docker exec "$container" test -x /app/gows
docker exec "$container" ffmpeg -version >/dev/null

for session in smoke-one smoke-two; do
  curl -fsS -X DELETE \
    -H "X-Api-Key: ${api_key}" \
    "http://127.0.0.1:${port}/api/sessions/${session}" >/dev/null
done

echo "WAHA GOWS smoke test passed for ${image}"
