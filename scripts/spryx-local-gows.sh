#!/bin/sh
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
compose_file="${root}/docker-compose.spryx-local.yaml"
project="${WAHA_LOCAL_COMPOSE_PROJECT:-spryx-waha-local}"
port="${WAHA_LOCAL_PORT:-3300}"
base_url="${WAHA_LOCAL_BASE_URL:-http://127.0.0.1:${port}}"
api_key="${WAHA_LOCAL_API_KEY:-spryx-local-api-key}"
dashboard_username="${WAHA_LOCAL_DASHBOARD_USERNAME:-admin}"
dashboard_password="${WAHA_LOCAL_DASHBOARD_PASSWORD:-spryx-local-dashboard}"
session="${WAHA_LOCAL_SESSION:-spryx-local}"
state_dir="${root}/.spryx-local"
image_file="${state_dir}/image"

case "$session" in
  *[!a-zA-Z0-9_-]*|'')
    echo "WAHA_LOCAL_SESSION may only contain letters, digits, underscore and hyphen." >&2
    exit 1
    ;;
esac

usage() {
  cat <<'EOF'
Usage: scripts/spryx-local-gows.sh COMMAND

Commands:
  build              Build the exact local Spryx WAHA/GOWS fork image
  up                 Start WAHA and preserve session/media data across restarts
  pair               Create/start the session and open its QR code
  status             Show runtime readiness, session status and dashboard details
  open               Open the local WAHA dashboard
  canary CHAT_ID     Send text/media/reply and verify bounded history
  restart            Restart the container and prove the paired session is restored
  logs               Follow WAHA logs
  down               Stop containers while preserving paired credentials and media
  destroy            Delete local containers, paired credentials and media

CHAT_ID accepts either 5511999999999 or 5511999999999@c.us.
All local defaults can be overridden with WAHA_LOCAL_* environment variables.
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

compose() {
  WAHA_LOCAL_IMAGE="$(resolve_image)" \
    WAHA_LOCAL_PORT="$port" \
    WAHA_LOCAL_API_KEY="$api_key" \
    WAHA_LOCAL_DASHBOARD_USERNAME="$dashboard_username" \
    WAHA_LOCAL_DASHBOARD_PASSWORD="$dashboard_password" \
    WAHA_LOCAL_SESSION="$session" \
    docker compose --project-name "$project" --file "$compose_file" "$@"
}

resolve_image() {
  if [ -n "${WAHA_LOCAL_IMAGE:-}" ]; then
    printf '%s\n' "$WAHA_LOCAL_IMAGE"
    return
  fi
  if [ -f "$image_file" ]; then
    sed -n '1p' "$image_file"
    return
  fi
  echo "No local image is recorded. Run '$0 build' first." >&2
  exit 1
}

api() {
  method="$1"
  path="$2"
  data="${3:-}"
  if [ -n "$data" ]; then
    curl -fsS \
      -X "$method" \
      -H "X-Api-Key: ${api_key}" \
      -H 'Content-Type: application/json' \
      --data "$data" \
      "${base_url}${path}"
  else
    curl -fsS \
      -X "$method" \
      -H "X-Api-Key: ${api_key}" \
      "${base_url}${path}"
  fi
}

open_target() {
  target="$1"
  if command -v open >/dev/null 2>&1; then
    open "$target"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$target"
  else
    echo "Open this address manually: $target"
  fi
}

wait_for_api() {
  attempt=0
  while [ "$attempt" -lt 120 ]; do
    if api GET /api/server/version >/dev/null 2>&1; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "WAHA did not expose its API within 120 seconds." >&2
  compose logs --tail=200 waha >&2
  exit 1
}

session_status() {
  api GET "/api/sessions/${session}"
}

wait_for_working() {
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    status="$(session_status 2>/dev/null || true)"
    if printf '%s' "$status" | node -e '
      let body = "";
      process.stdin.on("data", (chunk) => body += chunk);
      process.stdin.on("end", () => {
        try {
          process.exit(JSON.parse(body).status === "WORKING" ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    '; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Session '${session}' did not reach WORKING within 180 seconds." >&2
  session_status >&2 || true
  exit 1
}

build_image() {
  require_command docker
  mkdir -p "$state_dir"
  metadata="$("${root}/scripts/spryx-image-metadata.sh")"
  version="$(printf '%s\n' "$metadata" | sed -n 's/^version=//p')"
  revision="$(printf '%s\n' "$metadata" | sed -n 's/^revision=//p')"
  tag="$(printf '%s\n' "$metadata" | sed -n 's/^tag=//p')"
  image="local/spryx-waha:${tag}"

  docker build \
    --build-arg USE_BROWSER=none \
    --build-arg WHATSAPP_DEFAULT_ENGINE=GOWS \
    --build-arg "WAHA_BUILD_REVISION=${revision}" \
    --build-arg "WAHA_BUILD_VERSION=${version}" \
    --build-arg WAHA_IMAGE_SOURCE=https://github.com/Spryx-AI/waha \
    --tag "$image" \
    "$root"

  printf '%s\n' "$image" > "$image_file"
  echo "Built and recorded ${image}"
}

start_local() {
  require_command docker
  require_command curl
  require_command node
  mkdir -p "${state_dir}/sessions" "${state_dir}/media"
  compose up --detach
  wait_for_api
  echo "WAHA is running at ${base_url}"
  print_access
}

print_access() {
  cat <<EOF
Dashboard: ${base_url}/dashboard
Swagger:   ${base_url}/swagger
User:      ${dashboard_username}
Password:  ${dashboard_password}
API key:   ${api_key}
Session:   ${session}
EOF
}

pair_session() {
  wait_for_api
  current="$(session_status 2>/dev/null || true)"
  if printf '%s' "$current" | node -e '
    let body = "";
    process.stdin.on("data", (chunk) => body += chunk);
    process.stdin.on("end", () => {
      try {
        process.exit(JSON.parse(body).status === "WORKING" ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '; then
    echo "Session '${session}' is already paired and WORKING."
    status_local
    return
  fi

  if ! session_status >/dev/null 2>&1; then
    api POST /api/sessions \
      "{\"name\":\"${session}\",\"start\":true,\"config\":{\"gows\":{\"storage\":{\"messages\":true,\"groups\":true,\"chats\":true,\"labels\":true}}}}" \
      >/dev/null
  else
    api POST "/api/sessions/${session}/start" '{}' >/dev/null
  fi

  qr_file="${state_dir}/qr-${session}.png"
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    code="$(
      curl -sS \
        -o "$qr_file" \
        -w '%{http_code}' \
        -H "X-Api-Key: ${api_key}" \
        -H 'Accept: image/png' \
        "${base_url}/api/${session}/auth/qr" ||
        true
    )"
    if [ "$code" = 200 ] && [ -s "$qr_file" ]; then
      echo "QR code saved to ${qr_file}"
      open_target "$qr_file"
      print_pairing_steps
      wait_for_working
      echo "Session '${session}' is WORKING."
      status_local
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "QR was not available. Open the dashboard to inspect the session." >&2
  open_dashboard
  session_status >&2 || true
  exit 1
}

print_pairing_steps() {
  cat <<'EOF'
On the phone that owns the canary number:
  WhatsApp -> Settings/Menu -> Linked devices -> Link a device
Scan the QR that just opened. Do not use a production customer number.
EOF
}

status_local() {
  wait_for_api
  echo "Runtime readiness:"
  api GET /health/ready
  printf '\nSession:\n'
  session_status
  printf '\nAccess:\n'
  print_access
}

open_dashboard() {
  print_access
  open_target "${base_url}/dashboard"
}

normalize_chat_id() {
  value="${1#+}"
  case "$value" in
    *@*) printf '%s\n' "$value" ;;
    *) printf '%s@c.us\n' "$value" ;;
  esac
}

run_canary() {
  if [ "$#" -ne 1 ]; then
    echo "Usage: $0 canary PHONE_OR_CHAT_ID" >&2
    exit 1
  fi
  wait_for_working
  chat_id="$(normalize_chat_id "$1")"
  WAHA_CANARY_BASE_URL="$base_url" \
    WAHA_CANARY_API_KEY="$api_key" \
    WAHA_CANARY_SESSION="$session" \
    WAHA_CANARY_CHAT_ID="$chat_id" \
    node "${root}/scripts/spryx-paired-gows.mjs"
}

restart_local() {
  wait_for_working
  before="$(api GET "/api/sessions/${session}/me")"
  compose restart waha
  wait_for_api
  wait_for_working
  after="$(api GET "/api/sessions/${session}/me")"
  BEFORE="$before" AFTER="$after" node <<'NODE'
const before = JSON.parse(process.env.BEFORE);
const after = JSON.parse(process.env.AFTER);
const beforeId = before?.id ?? before?.wid ?? before?.phoneNumber;
const afterId = after?.id ?? after?.wid ?? after?.phoneNumber;
if (!beforeId || beforeId !== afterId) {
  throw new Error(
    `Paired identity changed after restart: ${JSON.stringify({ before, after })}`,
  );
}
process.stdout.write(`Container restart restored paired identity ${beforeId}.\n`);
NODE
  status_local
}

destroy_local() {
  echo "This permanently logs out the local test session by deleting its credentials."
  printf "Type the session name '%s' to continue: " "$session"
  read -r confirmation
  if [ "$confirmation" != "$session" ]; then
    echo "Confirmation did not match; nothing was deleted."
    exit 1
  fi
  compose down --remove-orphans
  rm -rf "${state_dir}/sessions" "${state_dir}/media"
  rm -f "${state_dir}/qr-${session}.png"
  echo "Deleted local paired credentials and media for '${session}'."
}

command="${1:-}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  build) build_image "$@" ;;
  up) start_local "$@" ;;
  pair) pair_session "$@" ;;
  status) status_local "$@" ;;
  open) open_dashboard "$@" ;;
  canary) run_canary "$@" ;;
  restart) restart_local "$@" ;;
  logs) compose logs --follow waha ;;
  down)
    compose down --remove-orphans
    echo "Stopped WAHA. Paired credentials and media remain in ${state_dir}."
    ;;
  destroy) destroy_local "$@" ;;
  *) usage; exit 1 ;;
esac
