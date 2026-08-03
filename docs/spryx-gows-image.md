# Spryx GOWS image

Spryx deploys a reproducible WAHA Core image built from this fork with the GOWS
engine. Building and running the Core image does not require a Patreon account,
a private registry login, or a WAHA Plus license.

## Immutable identity

Every release uses the tag below:

```text
gows-<WAHA version>-<full Git SHA>
```

The full commit SHA prevents a tag from ambiguously identifying multiple source
revisions. The image also exposes its source revision and WAHA version through:

- OCI labels `org.opencontainers.image.source`,
  `org.opencontainers.image.revision`, and
  `org.opencontainers.image.version`;
- `GET /api/server/version`, under the `build` object.

The deployment must inject `WAHA_IMAGE_REFERENCE` and `WAHA_IMAGE_DIGEST` after
ECR resolves the pushed manifest. A container cannot discover its own registry
digest while it is being built.

## Local build and smoke test

Resolve the current source metadata:

```bash
scripts/spryx-image-metadata.sh
```

Build an image using the returned values:

```bash
docker build \
  --build-arg USE_BROWSER=none \
  --build-arg WHATSAPP_DEFAULT_ENGINE=GOWS \
  --build-arg WAHA_BUILD_REVISION=<full Git SHA> \
  --build-arg WAHA_BUILD_VERSION=<WAHA version> \
  --build-arg WAHA_IMAGE_SOURCE=https://github.com/Spryx-AI/waha \
  --tag local/waha:<immutable tag> \
  .
```

Run the credential-free smoke suite:

```bash
scripts/spryx-smoke-gows.sh local/waha:<immutable tag>
```

Run the complete offline compatibility gate and review the paired release
matrix in [`spryx-gows-compatibility.md`](spryx-gows-compatibility.md):

```bash
WAHA_COMPATIBILITY_IMAGE=local/waha:<immutable tag> \
  scripts/spryx-compatibility-gows.sh
```

The suite validates startup, API-key enforcement, health, build metadata, GOWS
and FFmpeg availability, runtime readiness, and creation/listing/deletion of
stopped sessions. It does not authenticate a WhatsApp number or send and
receive messages.

## Runtime evidence

`GET /health` remains the storage health check. `GET /health/ready` reports the
shared GOWS process separately from session-scoped connectivity and gRPC event
streams.

The readiness response includes:

- the worker id, active-session count, managed-process state, PID, and last
  process exit;
- per-session event-stream state, connection attempts, interruptions, and
  reconnects;
- session disconnect, restoration, and keepalive counters.

An individual session disconnect is visible but does not mark the shared worker
down. An unexpected GOWS process exit marks worker readiness down and emits
structured logs with the exit code or signal, worker id, active-session count,
and bounded panic/OOM diagnostic evidence. The WAHA worker then terminates so
its process supervisor can replace it.

## GitHub Actions publication

`.github/workflows/spryx-gows-image.yaml` builds and smoke-tests native AMD64
and ARM64 images for each pull request. Its manual `workflow_dispatch` can
publish a multi-platform manifest to staging ECR after both architectures pass.
Production promotion requires an explicit staging manifest digest and copies
that exact manifest instead of rebuilding it.

Staging publication uses the `staging` GitHub environment. Production promotion
uses the protected `production` GitHub environment, so its OIDC subject is
`repo:Spryx-AI/waha:environment:production`. Both environments require:

- `WAHA_ECR_ROLE_ARN`
- `AWS_REGION`
- `WAHA_ECR_REPOSITORY`

The production environment also requires:

- `WAHA_STAGING_ECR_REGISTRY`
- `WAHA_STAGING_ECR_REPOSITORY`

The production OIDC role needs read access to the staging repository and write
access to the production repository. The staging repository policy must permit
that cross-account read when the registries use different AWS accounts.

The Terraform repository must create the ECR repository, OIDC role, and
least-privilege permissions before publication is enabled. No long-lived AWS
credentials belong in this repository.

At runtime, configure the approved webhook endpoint and
`WHATSAPP_HOOK_HMAC_KEY`. The key must match the ingress verifier secret; it is
a runtime secret and must not be stored in GitHub variables or image metadata.

## Paired WhatsApp canary

Before promoting a new digest, connect a disposable canary number and validate:

- QR authentication and session restoration after container restart;
- inbound and outbound text;
- inbound and outbound image, audio, document, and video;
- webhook delivery, stable WhatsApp IDs, acknowledgements, and deduplication;
- controlled loss and recovery of network access;
- timeout ambiguity, ensuring the application keeps the message pending until
  webhook correlation or reconciliation establishes the terminal state.

Record the tested image digest with the canary evidence. Production deployment
must reference that digest, not a mutable tag.
