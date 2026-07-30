import { cleanupSessionWebhookTargets } from '@waha/core/integrations/webhooks/WebhookTargetCleanup';
import { ISessionConfigRepository } from '@waha/core/storage/ISessionConfigRepository';
import { WAHAEvents } from '@waha/structures/enums.dto';
import { SessionConfig } from '@waha/structures/sessions.dto';

class MemorySessionConfigRepository implements ISessionConfigRepository {
  constructor(private configs: Map<string, SessionConfig>) {}

  saveConfig = jest.fn(
    async (sessionName: string, config: SessionConfig): Promise<void> => {
      this.configs.set(sessionName, config);
    },
  );

  async getConfig(sessionName: string): Promise<SessionConfig | null> {
    return this.configs.get(sessionName) ?? null;
  }

  async getConfigBySessions(
    sessionNames: string[],
  ): Promise<Map<string, SessionConfig | null>> {
    return new Map(
      sessionNames.map((name) => [name, this.configs.get(name) ?? null]),
    );
  }

  async exists(sessionName: string): Promise<boolean> {
    return this.configs.has(sessionName);
  }

  async deleteConfig(sessionName: string): Promise<void> {
    this.configs.delete(sessionName);
  }

  async getAllConfigs(): Promise<string[]> {
    return [...this.configs.keys()];
  }

  async init(): Promise<void> {}
}

function target(url: string) {
  return { url: url, events: [WAHAEvents.MESSAGE_ANY] };
}

describe('cleanupSessionWebhookTargets', () => {
  it('reports changes without mutating in dry-run mode', async () => {
    const repository = new MemorySessionConfigRepository(
      new Map([
        [
          'quality-life',
          {
            metadata: { tenant: 'quality-life' },
            webhooks: [
              target('https://approved.example/waha'),
              target('https://approved.example/waha/'),
              target('http://localhost:3000/webhook'),
              target('https://stale.example/webhook'),
            ],
          },
        ],
      ]),
    );

    const result = await cleanupSessionWebhookTargets(repository, {
      approvedUrl: 'https://approved.example/waha',
      globalApprovedTargetConfigured: true,
      apply: false,
    });

    expect(result).toMatchObject({
      mode: 'dry-run',
      sessionsScanned: 1,
      sessionsChanged: 1,
      staleRemoved: 2,
      duplicatesRemoved: 2,
    });
    expect(repository.saveConfig).not.toHaveBeenCalled();
  });

  it('preserves non-webhook config and is idempotent when applied', async () => {
    const repository = new MemorySessionConfigRepository(
      new Map([
        [
          'quality-life',
          {
            metadata: { tenant: 'quality-life' },
            webhooks: [
              target('https://approved.example/waha'),
              target('https://stale.example/webhook'),
            ],
          },
        ],
      ]),
    );

    const first = await cleanupSessionWebhookTargets(repository, {
      approvedUrl: 'https://approved.example/waha',
      globalApprovedTargetConfigured: false,
      apply: true,
    });
    const second = await cleanupSessionWebhookTargets(repository, {
      approvedUrl: 'https://approved.example/waha',
      globalApprovedTargetConfigured: false,
      apply: true,
    });

    expect(first.sessionsChanged).toBe(1);
    expect(second.sessionsChanged).toBe(0);
    expect(repository.saveConfig).toHaveBeenCalledTimes(1);
    await expect(repository.getConfig('quality-life')).resolves.toMatchObject({
      metadata: { tenant: 'quality-life' },
      webhooks: [target('https://approved.example/waha')],
    });
  });
});
