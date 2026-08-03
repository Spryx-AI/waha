import { WebhookConfig } from '@waha/structures/webhooks.config.dto';
import * as crypto from 'node:crypto';

export type WebhookTargetScope = 'global' | 'session';

export interface WebhookTarget {
  key: string;
  scope: WebhookTargetScope;
  position: number;
  config: WebhookConfig;
}

function canonicalWebhookConfig(config: WebhookConfig): string {
  const headers = [...(config.customHeaders ?? [])]
    .map((header) => ({ name: header.name, value: header.value }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify({
    url: config.url,
    hmac: config.hmac?.key ?? null,
    retries: {
      attempts: config.retries?.attempts ?? null,
      delaySeconds: config.retries?.delaySeconds ?? null,
      policy: config.retries?.policy ?? null,
    },
    customHeaders: headers,
  });
}

export function buildWebhookTarget(
  scope: WebhookTargetScope,
  position: number,
  config: WebhookConfig,
): WebhookTarget {
  const fingerprint = crypto
    .createHash('sha256')
    .update(canonicalWebhookConfig(config))
    .digest('hex');
  return {
    key: `${scope}:${position}:${fingerprint}`,
    scope: scope,
    position: position,
    config: config,
  };
}
