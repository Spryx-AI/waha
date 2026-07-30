# Local Spryx WAHA/GOWS pairing and canary

This procedure builds and runs the exact source in this fork. It does not pull
the mutable upstream `latest` image and does not need Patreon, WAHA Plus, AWS
credentials, or private registry credentials.

## Prerequisites

- Docker Desktop or OrbStack with Docker Compose available;
- a disposable WhatsApp canary number on a phone;
- a second WhatsApp number or chat that may safely receive the canary messages.

The local endpoint only binds to `127.0.0.1`. The default dashboard password and
API key are deliberately local-only values. Override any of them with
`WAHA_LOCAL_*` environment variables when needed.

## Build and start

From this repository:

```bash
scripts/spryx-local-gows.sh build
scripts/spryx-local-gows.sh up
```

The first command records the immutable local image reference under
`.spryx-local/`. The second starts that exact image and prints:

- dashboard and Swagger URLs;
- dashboard username and password;
- API key;
- session name.

Sessions and downloaded media live under `.spryx-local/sessions` and
`.spryx-local/media`. Both directories are ignored by Git.

## Pair WhatsApp

```bash
scripts/spryx-local-gows.sh pair
```

The command creates or starts the `spryx-local` GOWS session, downloads its QR
as a PNG, opens it, and waits for `WORKING`.

On the canary phone:

1. open WhatsApp;
2. open **Settings/Menu → Linked devices → Link a device**;
3. scan the displayed QR;
4. keep WhatsApp connected until the command reports `WORKING`.

The dashboard remains available at
[http://127.0.0.1:3300/dashboard](http://127.0.0.1:3300/dashboard). Run
`scripts/spryx-local-gows.sh open` to open it again or
`scripts/spryx-local-gows.sh status` to inspect readiness and the session.

## Run the paired canary

Use a destination number in international format without `+` or pass a complete
WAHA chat ID:

```bash
scripts/spryx-local-gows.sh canary 5511999999999
# equivalent: scripts/spryx-local-gows.sh canary 5511999999999@c.us
```

The canary sends text, image, voice, video, PDF, and a reply. Every send uses a
pre-generated provider ID, and the script waits until every returned ID exists
in bounded GOWS history.

Confirm on the destination phone that all six messages arrived and that the last
message is visibly a reply to the first text.

For inbound validation, send a text and each required media type from the
destination phone back to the canary number. The full Spryx local E2E harness
consumes those events; the WAHA dashboard and API may be used for a fork-only
check.

## Prove credential restoration

```bash
scripts/spryx-local-gows.sh restart
```

This captures the paired identity, restarts the WAHA container, waits for API
readiness and `WORKING`, and requires the restored identity to match. No new QR
should appear.

Run the canary once more after the restart to prove send and history behavior:

```bash
scripts/spryx-local-gows.sh canary 5511999999999
```

## Stop safely

```bash
scripts/spryx-local-gows.sh down
```

This removes the container and network but deliberately preserves the paired
credentials and media. A later `up` restores the same linked device.

Only use the destructive command when the local pairing must be removed:

```bash
scripts/spryx-local-gows.sh destroy
```

`destroy` requires typing the exact session name before deleting credentials.
Afterward, WhatsApp may still display the stale linked-device entry until it is
removed from the phone.

## Optional overrides

```bash
export WAHA_LOCAL_PORT=3300
export WAHA_LOCAL_SESSION=spryx-local
export WAHA_LOCAL_API_KEY=another-local-key
export WAHA_LOCAL_DASHBOARD_USERNAME=admin
export WAHA_LOCAL_DASHBOARD_PASSWORD=another-local-password
```

`WAHA_LOCAL_IMAGE` may point to an already-built immutable image and bypass the
recorded `.spryx-local/image` value.
