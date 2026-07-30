# Spryx GOWS compatibility matrix

This matrix is the release gate for the public WAHA Core GOWS image. It
separates evidence that is reproducible without WhatsApp credentials from
checks that require paired accounts and the real WhatsApp network.

## Credential-free gate

Run:

```bash
scripts/spryx-compatibility-gows.sh
```

Set `WAHA_COMPATIBILITY_IMAGE` to also execute the container smoke suite.

| Capability | Offline evidence | Expected result |
| --- | --- | --- |
| Core/GOWS build without Patreon or private registry | `Dockerfile`, image metadata test, container smoke | Tier is `CORE`, engine is `GOWS`, immutable revision is exposed |
| Shared GOWS process start, readiness and unexpected exit | `GowsSubprocess.test.ts`, `GowsRuntimeState.test.ts`, `GowsRuntimeHealthIndicator.test.ts` | Process failure marks the worker unready; a session disconnect does not |
| Event-stream interruption and reconnect | `GowsEventStreamObservable.test.ts` | Stream reconnects with bounded backoff without stopping other sessions |
| Durable `message.any`/`message.ack` delivery | `WebhookOutbox.test.ts` | Event is stored before POST, survives process restart, and is leased once |
| Webhook target reconfiguration during restart | `WebhookOutbox.test.ts` | Pending event retains the exact original target snapshot |
| HMAC v2 | `WebhookSender.hmac.test.ts` | Signature covers current delivery timestamp and exact body |
| TLS verification | `WebhookSender.tls.test.ts` | Trusted matching certificate passes; untrusted or wrong-host certificate fails |
| Persisted session configuration | container smoke | Stopped named sessions can be created, listed and removed on the configured store |
| Stable client-generated IDs in request contracts | TypeScript build plus `GowsPairedCanary.test.ts` for text/image/audio/video/document DTOs and GOWS send methods | Every required send request accepts `id`; the canary asserts the returned serialized ID |
| Webhook target cleanup | `WebhookTargetCleanup.test.ts` | Dry-run is non-mutating; apply is scoped and idempotent |

Offline evidence proves the runtime contracts and failure handling. It cannot
prove how the live WhatsApp service accepts media, emits receipts, restores an
authenticated device, or behaves during a real network partition.

## Paired canary gate

Required environment:

```bash
export WAHA_CANARY_BASE_URL=https://waha-canary.example
export WAHA_CANARY_API_KEY=...
export WAHA_CANARY_SESSION=spryx-canary
export WAHA_CANARY_CHAT_ID=5511999999999@c.us
node scripts/spryx-paired-gows.mjs
```

The script uses the versioned image, audio, MP4 video and PDF fixtures under
`examples/`. It sends text, image, audio, video, document and a reply with pre-generated IDs,
then proves all returned IDs exist in bounded GOWS history. Set
`WAHA_CANARY_TEST_SESSION_RESTART=1` to restart the session and verify history
again without logging out.

| Capability | Paired procedure | Pass condition |
| --- | --- | --- |
| Outbound text/image/audio/video/document | paired script | API returns the requested generated ID and history contains it |
| Reply correlation | paired script | Reply is accepted with the original serialized ID and both appear in history |
| `message.any` | capture approved ingress events for the script run ID | Exactly one event per provider message ID |
| `message.ack` | capture approved ingress events until terminal receipt | ACKs are monotonic and correlate to the same provider message ID |
| Inbound text and media | send from a second paired account to the canary | Webhook and history contain the same provider ID; media is downloadable |
| History and media pagination | query multiple pages around the canary window | No gaps or duplicates across the cursor/offset overlap |
| Session restart | paired script with restart enabled | Session returns to `WORKING`; credentials and history remain |
| Process/container restart | restart the immutable canary container without deleting its store | Session is restored without QR; pending webhook events are delivered |
| Network loss and recovery | block WhatsApp egress, send/receive canary traffic, then restore | Worker stays observable, affected session recovers, persisted events are not lost |
| Ambiguous send timeout | interrupt the client response after WhatsApp accepts the generated ID | Reconciliation finds one provider message; no blind duplicate send |

## Evidence record

For every candidate digest, retain:

- immutable image digest, source revision and WAHA version;
- timestamps and JSON output from both compatibility scripts;
- ingress records for `message.any` and `message.ack`;
- history results before and after session/process restart;
- the failure-injection window and recovery timestamps.

Do not promote a mutable tag or treat an offline pass as a substitute for the
paired canary gate.
