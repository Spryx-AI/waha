import { WebhookOutbox } from '@waha/core/integrations/webhooks/WebhookOutbox';
import {
  migrateWebhookOutbox,
  WEBHOOK_ATTEMPT_TABLE,
  WEBHOOK_OUTBOX_TABLE,
  WebhookOutboxRepository,
} from '@waha/core/integrations/webhooks/WebhookOutboxRepository';
import { buildWebhookTarget } from '@waha/core/integrations/webhooks/WebhookTarget';
import { WAHAEvents } from '@waha/structures/enums.dto';
import { LoggerBuilder } from '@waha/utils/logging';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import Knex, { Knex as KnexType } from 'knex';

function buildLogger(): LoggerBuilder {
  const logger: any = {
    child: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not met');
}

describe('WebhookOutbox', () => {
  let directory: string;
  let database: string;
  let knex: KnexType;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waha-outbox-'));
    database = path.join(directory, 'outbox.sqlite3');
  });

  afterEach(async () => {
    await knex?.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function connect(): KnexType {
    return Knex({
      client: 'better-sqlite3',
      connection: { filename: database },
      useNullAsDefault: true,
    });
  }

  it('adds the durable target snapshot to an existing outbox schema', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    await knex.schema.alterTable(WEBHOOK_OUTBOX_TABLE, (table) => {
      table.dropColumn('target_config_json');
    });
    await expect(
      knex.schema.hasColumn(WEBHOOK_OUTBOX_TABLE, 'target_config_json'),
    ).resolves.toBe(false);

    await migrateWebhookOutbox(knex);

    await expect(
      knex.schema.hasColumn(WEBHOOK_OUTBOX_TABLE, 'target_config_json'),
    ).resolves.toBe(true);
  });

  it('restores a pending event after restart and delivers the same identity once', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('global', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE_ANY],
    });
    const webhook = {
      id: 'evt_01aaaaaaaaaaaaaaaaaaaaaaaa',
      timestamp: Date.now(),
      session: 'quality-life',
      event: WAHAEvents.MESSAGE_ANY,
      payload: { id: 'provider-message-id' },
    };
    const firstRepository = new WebhookOutboxRepository(knex);
    const firstOutbox = new WebhookOutbox(firstRepository, buildLogger(), {
      workerId: 'worker-before-restart',
      pollMilliseconds: 5,
    });

    await firstOutbox.enqueue(target, webhook);
    expect(await knex(WEBHOOK_OUTBOX_TABLE).first()).toMatchObject({
      event_id: webhook.id,
      status: 'pending',
      attempt_count: 0,
    });
    await knex.destroy();

    knex = connect();
    await migrateWebhookOutbox(knex);
    const sender = {
      sendOnce: jest.fn().mockResolvedValue({
        status: 202,
        requestId: 'request-after-restart',
      }),
    };
    const restored = new WebhookOutbox(
      new WebhookOutboxRepository(knex),
      buildLogger(),
      {
        workerId: 'worker-after-restart',
        pollMilliseconds: 5,
      },
    );
    restored.register(target, sender as any);
    restored.start();

    await eventually(async () => {
      const row = await knex(WEBHOOK_OUTBOX_TABLE).first();
      return row?.status === 'delivered';
    });
    restored.stop();

    expect(sender.sendOnce).toHaveBeenCalledTimes(1);
    expect(sender.sendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ id: webhook.id }),
    );
    expect(await knex(WEBHOOK_OUTBOX_TABLE).first()).toMatchObject({
      event_id: webhook.id,
      status: 'delivered',
      attempt_count: 1,
    });
    expect(await knex(WEBHOOK_ATTEMPT_TABLE)).toHaveLength(1);

    await restored.enqueue(target, webhook);
    restored.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    restored.stop();
    expect(sender.sendOnce).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed delivery durable and schedules a later retry', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('session', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE_ACK],
    });
    const sender = {
      sendOnce: jest.fn().mockRejectedValue(
        Object.assign(new Error('connection reset'), {
          isAxiosError: true,
          code: 'ECONNRESET',
          config: { headers: {} },
        }),
      ),
    };
    const outbox = new WebhookOutbox(
      new WebhookOutboxRepository(knex),
      buildLogger(),
      {
        workerId: 'worker-one',
        pollMilliseconds: 5,
      },
    );
    outbox.register(target, sender as any);
    await outbox.enqueue(target, {
      id: 'evt_01bbbbbbbbbbbbbbbbbbbbbbbb',
      timestamp: Date.now(),
      session: 'quality-life',
      event: WAHAEvents.MESSAGE_ACK,
      payload: { ack: 2 },
    });
    outbox.start();

    await eventually(async () => {
      const row = await knex(WEBHOOK_OUTBOX_TABLE).first();
      return row?.status === 'retry';
    });
    outbox.stop();

    expect(await knex(WEBHOOK_OUTBOX_TABLE).first()).toMatchObject({
      status: 'retry',
      attempt_count: 1,
      last_error_class: 'transport',
      last_error_code: 'ECONNRESET',
    });
    expect(await knex(WEBHOOK_ATTEMPT_TABLE)).toHaveLength(1);
  });

  it('restores the original target after restart without active session registration', async () => {
    const received: any[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(202);
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const port = (server.address() as any).port;
      const target = buildWebhookTarget('session', 0, {
        url: `http://127.0.0.1:${port}/waha`,
        events: [WAHAEvents.MESSAGE_ANY],
      });
      const webhook = {
        id: 'evt_01cccccccccccccccccccccccc',
        timestamp: Date.now(),
        session: 'quality-life',
        event: WAHAEvents.MESSAGE_ANY,
        payload: { id: 'provider-message-id' },
      };

      knex = connect();
      await migrateWebhookOutbox(knex);
      await new WebhookOutboxRepository(knex).enqueue({
        eventId: webhook.id,
        targetKey: target.key,
        sessionName: webhook.session,
        eventType: webhook.event,
        eventTimestampMs: webhook.timestamp,
        targetConfig: target.config,
        payload: webhook,
        payloadSha256: 'test-sha',
      });
      await knex.destroy();

      knex = connect();
      const restored = new WebhookOutbox(
        new WebhookOutboxRepository(knex),
        buildLogger(),
        {
          workerId: 'worker-after-restart',
          pollMilliseconds: 5,
        },
      );
      restored.start();
      await eventually(async () => {
        const row = await knex(WEBHOOK_OUTBOX_TABLE).first();
        return row?.status === 'delivered';
      });
      restored.stop();

      expect(received).toEqual([
        expect.objectContaining({
          id: webhook.id,
          event: WAHAEvents.MESSAGE_ANY,
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
