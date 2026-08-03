import { ISessionConfigRepository } from '@waha/core/storage/ISessionConfigRepository';
import { WebhookConfig } from '@waha/structures/webhooks.config.dto';

export interface WebhookCleanupSessionResult {
  session: string;
  originalTargets: number;
  retainedTargets: number;
  staleRemoved: number;
  duplicatesRemoved: number;
  changed: boolean;
}

export interface WebhookCleanupResult {
  mode: 'dry-run' | 'apply';
  sessionsScanned: number;
  sessionsChanged: number;
  staleRemoved: number;
  duplicatesRemoved: number;
  sessions: WebhookCleanupSessionResult[];
}

export interface WebhookCleanupOptions {
  approvedUrl: string;
  globalApprovedTargetConfigured: boolean;
  apply: boolean;
}

export function normalizeWebhookUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return null;
  }
}

export async function cleanupSessionWebhookTargets(
  repository: ISessionConfigRepository,
  options: WebhookCleanupOptions,
): Promise<WebhookCleanupResult> {
  const approvedUrl = normalizeWebhookUrl(options.approvedUrl);
  if (!approvedUrl) {
    throw new Error('Approved webhook URL is invalid');
  }
  const sessions: WebhookCleanupSessionResult[] = [];
  const sessionNames = (await repository.getAllConfigs()).sort();

  for (const sessionName of sessionNames) {
    const config = await repository.getConfig(sessionName);
    const original = config?.webhooks ?? [];
    const approved: WebhookConfig[] = [];
    let staleRemoved = 0;
    for (const target of original) {
      if (normalizeWebhookUrl(target.url) === approvedUrl) {
        approved.push(target);
      } else {
        staleRemoved += 1;
      }
    }

    const retained = options.globalApprovedTargetConfigured
      ? []
      : approved.slice(0, 1);
    const duplicatesRemoved = approved.length - retained.length;
    const changed = staleRemoved > 0 || duplicatesRemoved > 0;
    if (changed && options.apply) {
      await repository.saveConfig(sessionName, {
        ...(config ?? {}),
        webhooks: retained,
      });
    }
    sessions.push({
      session: sessionName,
      originalTargets: original.length,
      retainedTargets: retained.length,
      staleRemoved: staleRemoved,
      duplicatesRemoved: duplicatesRemoved,
      changed: changed,
    });
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    sessionsScanned: sessions.length,
    sessionsChanged: sessions.filter((session) => session.changed).length,
    staleRemoved: sessions.reduce(
      (total, session) => total + session.staleRemoved,
      0,
    ),
    duplicatesRemoved: sessions.reduce(
      (total, session) => total + session.duplicatesRemoved,
      0,
    ),
    sessions: sessions.filter((session) => session.changed),
  };
}
