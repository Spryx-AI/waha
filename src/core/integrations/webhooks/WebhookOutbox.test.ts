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

  it('persists message and message.any envelopes without duplicating a retried envelope', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('global', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE, WAHAEvents.MESSAGE_ANY],
    });
    const providerMessageId = 'false_5511999999999@c.us_PROVIDER_MESSAGE_ID';
    const message = {
      id: 'evt_01message00000000000000000',
      timestamp: Date.now(),
      session: 'quality-life',
      event: WAHAEvents.MESSAGE,
      payload: {
        id: providerMessageId,
        from: '5511999999999@c.us',
        fromMe: false,
        to: '5511888888888@c.us',
      },
    };
    const messageAny = {
      ...message,
      id: 'evt_01messageany0000000000000',
      event: WAHAEvents.MESSAGE_ANY,
    };
    const outbox = new WebhookOutbox(
      new WebhookOutboxRepository(knex),
      buildLogger(),
      { workerId: 'worker' },
    );

    await outbox.enqueue(target, message);
    await outbox.enqueue(target, messageAny);
    await outbox.enqueue(target, message);

    const rows = await knex(WEBHOOK_OUTBOX_TABLE)
      .select('event_id', 'event_type', 'payload_json')
      .orderBy('event_type');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.event_id)).toEqual(
      expect.arrayContaining([message.id, messageAny.id]),
    );
    expect(
      rows.map((row) => {
        const payload = JSON.parse(row.payload_json);
        return payload.payload.id;
      }),
    ).toEqual([providerMessageId, providerMessageId]);
  });

  it('claims a new message before an older session status', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('session', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE_ANY, WAHAEvents.SESSION_STATUS],
    });
    const repository = new WebhookOutboxRepository(knex);
    const enqueue = (
      eventId: string,
      eventType: WAHAEvents,
      timestamp: number,
    ) =>
      repository.enqueue({
        eventId,
        targetKey: target.key,
        sessionName: 'quality-life',
        eventType,
        eventTimestampMs: timestamp,
        targetConfig: target.config,
        payload: {
          id: eventId,
          timestamp,
          session: 'quality-life',
          event: eventType,
          payload: {},
        },
        payloadSha256: `${eventId}-sha`,
      });

    await enqueue('evt_older_status', WAHAEvents.SESSION_STATUS, 1_000);
    await enqueue('evt_new_message', WAHAEvents.MESSAGE_ANY, 2_000);

    const claimed = await repository.claim('worker', 60_000, {
      lane: 'live',
    });

    expect(claimed).toMatchObject({
      event_id: 'evt_new_message',
      event_type: WAHAEvents.MESSAGE_ANY,
    });
  });

  it('isolates status retries from the live message lane', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('session', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE, WAHAEvents.SESSION_STATUS],
    });
    const repository = new WebhookOutboxRepository(knex);
    const enqueue = (
      eventId: string,
      eventType: WAHAEvents,
      timestamp: number,
    ) =>
      repository.enqueue({
        eventId: eventId,
        targetKey: target.key,
        sessionName: 'quality-life',
        eventType: eventType,
        eventTimestampMs: timestamp,
        targetConfig: target.config,
        payload: {
          id: eventId,
          timestamp: timestamp,
          session: 'quality-life',
          event: eventType,
          payload: {},
        },
        payloadSha256: `${eventId}-sha`,
      });

    await enqueue('evt_status_retry', WAHAEvents.SESSION_STATUS, 1_000);
    await knex(WEBHOOK_OUTBOX_TABLE)
      .where({ event_id: 'evt_status_retry' })
      .update({ status: 'retry' });
    await enqueue('evt_fresh_message', WAHAEvents.MESSAGE, 2_000);

    const fresh = await repository.claim('worker', 60_000, {
      lane: 'live',
    });

    expect(fresh).toMatchObject({
      event_id: 'evt_fresh_message',
      event_type: WAHAEvents.MESSAGE,
    });
  });

  it('keeps FIFO fairness between event types in the live lane', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('session', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE, WAHAEvents.MESSAGE_REACTION],
    });
    const repository = new WebhookOutboxRepository(knex);
    const enqueue = (
      eventId: string,
      eventType: WAHAEvents,
      timestamp: number,
    ) =>
      repository.enqueue({
        eventId: eventId,
        targetKey: target.key,
        sessionName: 'quality-life',
        eventType: eventType,
        eventTimestampMs: timestamp,
        targetConfig: target.config,
        payload: {},
        payloadSha256: `${eventId}-sha`,
      });

    await enqueue('evt_older_reaction', WAHAEvents.MESSAGE_REACTION, 1_000);
    await enqueue('evt_new_message', WAHAEvents.MESSAGE, 2_000);

    const claimed = await repository.claim('worker', 60_000, { lane: 'live' });

    expect(claimed).toMatchObject({
      event_id: 'evt_older_reaction',
      event_type: WAHAEvents.MESSAGE_REACTION,
    });
  });

  it('delivers a fresh message while a status retry is blocked', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('session', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE, WAHAEvents.SESSION_STATUS],
    });
    let releaseRetry: () => void = () => undefined;
    const retryBlocked = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const deliveredEvents: string[] = [];
    const sender = {
      sendOnce: jest.fn().mockImplementation(async (webhook) => {
        deliveredEvents.push(webhook.event);
        if (webhook.event === WAHAEvents.SESSION_STATUS) {
          await retryBlocked;
        }
        return { status: 202, requestId: null };
      }),
    };
    const repository = new WebhookOutboxRepository(knex);
    const outbox = new WebhookOutbox(repository, buildLogger(), {
      workerId: 'worker',
      concurrency: 2,
      retryConcurrency: 1,
      pollMilliseconds: 5,
    });
    outbox.register(target, sender as any);
    await outbox.enqueue(target, {
      id: 'evt_status_retry',
      timestamp: 1_000,
      session: 'quality-life',
      event: WAHAEvents.SESSION_STATUS,
      payload: {},
    });
    await knex(WEBHOOK_OUTBOX_TABLE)
      .where({ event_id: 'evt_status_retry' })
      .update({ status: 'retry' });

    outbox.start();
    await eventually(async () =>
      deliveredEvents.includes(WAHAEvents.SESSION_STATUS),
    );
    await outbox.enqueue(target, {
      id: 'evt_fresh_message',
      timestamp: 2_000,
      session: 'quality-life',
      event: WAHAEvents.MESSAGE,
      payload: {},
    });

    await eventually(async () => deliveredEvents.includes(WAHAEvents.MESSAGE));
    expect(deliveredEvents).toEqual([
      WAHAEvents.SESSION_STATUS,
      WAHAEvents.MESSAGE,
    ]);

    releaseRetry();
    await eventually(async () => {
      const delivered = await knex(WEBHOOK_OUTBOX_TABLE)
        .where({ status: 'delivered' })
        .count({ count: '*' })
        .first();
      return Number(delivered?.count) === 2;
    });
    outbox.stop();
  });

  it('delivers a live message while a presence delivery is blocked', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('session', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE, WAHAEvents.PRESENCE_UPDATE],
    });
    let releasePresence: () => void = () => undefined;
    const presenceBlocked = new Promise<void>((resolve) => {
      releasePresence = resolve;
    });
    const deliveredEvents: string[] = [];
    const sender = {
      sendOnce: jest.fn().mockImplementation(async (webhook) => {
        deliveredEvents.push(webhook.event);
        if (webhook.event === WAHAEvents.PRESENCE_UPDATE) {
          await presenceBlocked;
        }
        return { status: 202, requestId: null };
      }),
    };
    const outbox = new WebhookOutbox(
      new WebhookOutboxRepository(knex),
      buildLogger(),
      {
        workerId: 'worker',
        concurrency: 3,
        retryConcurrency: 1,
        backgroundConcurrency: 1,
        pollMilliseconds: 5,
      },
    );
    outbox.register(target, sender as any);
    await outbox.enqueue(target, {
      id: 'evt_presence',
      timestamp: 1_000,
      session: 'quality-life',
      event: WAHAEvents.PRESENCE_UPDATE,
      payload: { chatId: 'joao@c.us' },
    });

    outbox.start();
    await eventually(async () =>
      deliveredEvents.includes(WAHAEvents.PRESENCE_UPDATE),
    );
    await outbox.enqueue(target, {
      id: 'evt_live_message',
      timestamp: 2_000,
      session: 'quality-life',
      event: WAHAEvents.MESSAGE,
      payload: { from: 'maria@c.us', fromMe: false, to: 'me@c.us' },
    });

    await eventually(async () => deliveredEvents.includes(WAHAEvents.MESSAGE));
    expect(deliveredEvents).toEqual([
      WAHAEvents.PRESENCE_UPDATE,
      WAHAEvents.MESSAGE,
    ]);

    releasePresence();
    await eventually(async () => {
      const delivered = await knex(WEBHOOK_OUTBOX_TABLE)
        .where({ status: 'delivered' })
        .count({ count: '*' })
        .first();
      return Number(delivered?.count) === 2;
    });
    outbox.stop();
  });

  it('delivers independent events concurrently', async () => {
    knex = connect();
    await migrateWebhookOutbox(knex);
    const target = buildWebhookTarget('session', 0, {
      url: 'https://channel-events.example/waha',
      events: [WAHAEvents.MESSAGE_ANY],
    });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender = {
      sendOnce: jest.fn().mockImplementation(async () => {
        await blocked;
        return { status: 202, requestId: null };
      }),
    };
    const outbox = new WebhookOutbox(
      new WebhookOutboxRepository(knex),
      buildLogger(),
      {
        workerId: 'worker',
        concurrency: 2,
        retryConcurrency: 1,
        pollMilliseconds: 5,
      },
    );
    outbox.register(target, sender as any);
    await outbox.enqueue(target, {
      id: 'evt_concurrent_one',
      timestamp: 1_000,
      session: 'quality-life',
      event: WAHAEvents.MESSAGE_ANY,
      payload: { from: 'joao@c.us', fromMe: false, to: 'me@c.us' },
    });
    await outbox.enqueue(target, {
      id: 'evt_concurrent_two',
      timestamp: 2_000,
      session: 'quality-life',
      event: WAHAEvents.MESSAGE_ANY,
      payload: { from: 'maria@c.us', fromMe: false, to: 'me@c.us' },
    });

    outbox.start();
    await eventually(async () => sender.sendOnce.mock.calls.length === 2);
    release();
    await eventually(async () => {
      const delivered = await knex(WEBHOOK_OUTBOX_TABLE)
        .where({ status: 'delivered' })
        .count({ count: '*' })
        .first();
      return Number(delivered?.count) === 2;
    });
    outbox.stop();
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
