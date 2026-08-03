import { getNamespace, getSessionNamespace } from '@waha/config';
import {
  cleanupSessionWebhookTargets,
  normalizeWebhookUrl,
} from '@waha/core/integrations/webhooks/WebhookTargetCleanup';
import { parsePsql } from '@waha/core/storage/psql/PsqlConnectionConfig';
import { PsqlSessionConfigRepository } from '@waha/core/storage/psql/PsqlSessionConfigRepository';
import { PsqlStore } from '@waha/core/storage/psql/PsqlStore';

export async function main(): Promise<void> {
  const databaseUrl = process.env.WHATSAPP_SESSIONS_POSTGRESQL_URL;
  const approvedUrl =
    process.env.WAHA_APPROVED_WEBHOOK_URL ?? process.env.WHATSAPP_HOOK_URL;
  if (!databaseUrl) {
    throw new Error('WHATSAPP_SESSIONS_POSTGRESQL_URL is required');
  }
  if (!approvedUrl) {
    throw new Error(
      'WAHA_APPROVED_WEBHOOK_URL or WHATSAPP_HOOK_URL is required',
    );
  }
  const apply = process.argv.includes('--apply');
  const globalApprovedTargetConfigured =
    process.env.WHATSAPP_HOOK_URL != null &&
    normalizeWebhookUrl(process.env.WHATSAPP_HOOK_URL) ===
      normalizeWebhookUrl(approvedUrl);
  const store = new PsqlStore(
    parsePsql(databaseUrl),
    getNamespace(),
    getSessionNamespace(),
  );
  try {
    await store.init();
    const repository = new PsqlSessionConfigRepository(store);
    await repository.init();
    const result = await cleanupSessionWebhookTargets(repository, {
      approvedUrl: approvedUrl,
      globalApprovedTargetConfigured: globalApprovedTargetConfigured,
      apply: apply,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
