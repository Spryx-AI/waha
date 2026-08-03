#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

yarn test:unit --runInBand --runTestsByPath \
  src/compatibility/GowsPairedCanary.test.ts \
  src/core/engines/gows/GowsEventStreamObservable.test.ts \
  src/core/engines/gows/GowsRuntimeState.test.ts \
  src/core/engines/gows/GowsSubprocess.test.ts \
  src/core/health/GowsRuntimeHealthIndicator.test.ts \
  src/core/integrations/webhooks/WebhookOutbox.test.ts \
  src/core/integrations/webhooks/WebhookSender.hmac.test.ts \
  src/core/integrations/webhooks/WebhookSender.tls.test.ts \
  src/core/integrations/webhooks/WebhookTargetCleanup.test.ts \
  src/version.test.ts
yarn lint
yarn build

if [ -n "${WAHA_COMPATIBILITY_IMAGE:-}" ]; then
  scripts/spryx-smoke-gows.sh "$WAHA_COMPATIBILITY_IMAGE"
fi

echo "Credential-free GOWS compatibility suite passed"
