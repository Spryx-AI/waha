import { Knex } from 'knex';
import { WebhookConfig } from '@waha/structures/webhooks.config.dto';

export const WEBHOOK_OUTBOX_TABLE = 'waha_webhook_outbox';
export const WEBHOOK_ATTEMPT_TABLE = 'waha_webhook_attempt';

export type WebhookOutboxStatus =
  | 'pending'
  | 'delivering'
  | 'retry'
  | 'delivered'
  | 'dead';

export interface WebhookOutboxRecord {
  event_id: string;
  target_key: string;
  session_name: string;
  event_type: string;
  event_timestamp_ms: number;
  target_config_json: WebhookConfig | string | null;
  payload_json: unknown;
  payload_sha256: string;
  status: WebhookOutboxStatus;
  attempt_count: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
}

export interface WebhookAttempt {
  eventId: string;
  targetKey: string;
  attemptNumber: number;
  requestId: string | null;
  workerId: string;
  startedAt: Date;
  finishedAt: Date;
  outcome: string;
  httpStatus?: number | null;
  errorClass?: string | null;
  errorCode?: string | null;
}

export type WebhookClaimLane = 'live' | 'background' | 'retry';

const LIVE_EVENT_TYPES = [
  'message',
  'message.any',
  'message.reaction',
  'message.revoked',
  'message.edited',
  'message.waiting',
];

export interface WebhookClaimOptions {
  lane?: WebhookClaimLane;
}

function isPostgres(knex: Knex): boolean {
  return String(knex.client.config.client).includes('pg');
}

async function createSchema(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(WEBHOOK_OUTBOX_TABLE))) {
    await knex.schema.createTable(WEBHOOK_OUTBOX_TABLE, (table) => {
      table.string('event_id', 64).notNullable();
      table.string('target_key', 160).notNullable();
      table.string('session_name', 128).notNullable();
      table.string('event_type', 128).notNullable();
      table.bigInteger('event_timestamp_ms').notNullable();
      table.json('target_config_json').nullable();
      table.json('payload_json').nullable();
      table.string('payload_sha256', 64).notNullable();
      table.string('status', 16).notNullable();
      table
        .integer('attempt_count')
        .notNullable()
        .defaultTo(0);
      table.timestamp('next_attempt_at').notNullable();
      table.string('lease_owner', 128).nullable();
      table.timestamp('lease_expires_at').nullable();
      table.timestamp('first_attempt_at').nullable();
      table.timestamp('last_attempt_at').nullable();
      table.timestamp('delivered_at').nullable();
      table.timestamp('dead_at').nullable();
      table.integer('last_http_status').nullable();
      table.string('last_error_class', 64).nullable();
      table.string('last_error_code', 128).nullable();
      table.timestamp('created_at').notNullable();
      table.timestamp('updated_at').notNullable();
      table.primary(['event_id', 'target_key']);
      table.index(['status', 'next_attempt_at'], 'waha_webhook_outbox_due');
      table.index(['status', 'lease_expires_at'], 'waha_webhook_outbox_lease');
      table.index(
        ['session_name', 'event_timestamp_ms'],
        'waha_webhook_outbox_session',
      );
      table.index(['delivered_at'], 'waha_webhook_outbox_delivered');
      table.index(['dead_at'], 'waha_webhook_outbox_dead');
    });
  }

  if (
    !(await knex.schema.hasColumn(WEBHOOK_OUTBOX_TABLE, 'target_config_json'))
  ) {
    await knex.schema.alterTable(WEBHOOK_OUTBOX_TABLE, (table) => {
      table.json('target_config_json').nullable();
    });
  }

  if (!(await knex.schema.hasTable(WEBHOOK_ATTEMPT_TABLE))) {
    await knex.schema.createTable(WEBHOOK_ATTEMPT_TABLE, (table) => {
      table.string('event_id', 64).notNullable();
      table.string('target_key', 160).notNullable();
      table.integer('attempt_number').notNullable();
      table.string('request_id', 128).nullable();
      table.string('worker_id', 128).notNullable();
      table.timestamp('started_at').notNullable();
      table.timestamp('finished_at').notNullable();
      table.string('outcome', 32).notNullable();
      table.integer('http_status').nullable();
      table.string('error_class', 64).nullable();
      table.string('error_code', 128).nullable();
      table.primary(['event_id', 'target_key', 'attempt_number']);
      table.index(['finished_at'], 'waha_webhook_attempt_finished');
    });
  }
}

export async function migrateWebhookOutbox(knex: Knex): Promise<void> {
  if (!isPostgres(knex)) {
    await createSchema(knex);
    return;
  }
  await knex.transaction(async (transaction) => {
    await transaction.raw(
      "SELECT pg_advisory_xact_lock(hashtext('waha_webhook_outbox_v1'))",
    );
    await createSchema(transaction);
  });
}

export class WebhookOutboxRepository {
  constructor(private knex: Knex) {}

  async enqueue(record: {
    eventId: string;
    targetKey: string;
    sessionName: string;
    eventType: string;
    eventTimestampMs: number;
    targetConfig: WebhookConfig;
    payload: unknown;
    payloadSha256: string;
  }): Promise<boolean> {
    const now = new Date();
    const result = await this.knex(WEBHOOK_OUTBOX_TABLE)
      .insert({
        event_id: record.eventId,
        target_key: record.targetKey,
        session_name: record.sessionName,
        event_type: record.eventType,
        event_timestamp_ms: record.eventTimestampMs,
        target_config_json: JSON.stringify(record.targetConfig),
        payload_json: JSON.stringify(record.payload),
        payload_sha256: record.payloadSha256,
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflict(['event_id', 'target_key'])
      .ignore();
    return Number(result[0] ?? 0) > 0;
  }

  async claim(
    workerId: string,
    leaseMilliseconds: number,
    options: WebhookClaimOptions = {},
  ): Promise<WebhookOutboxRecord | null> {
    return this.knex.transaction(async (transaction) => {
      const now = new Date();
      const lane = options.lane ?? 'live';
      const statuses = lane === 'retry' ? ['retry'] : ['pending'];
      let query = transaction(WEBHOOK_OUTBOX_TABLE)
        .whereIn('status', statuses)
        .where('next_attempt_at', '<=', now)
        .orderBy('next_attempt_at', 'asc')
        .orderBy('event_timestamp_ms', 'asc')
        .orderBy('event_id', 'asc')
        .orderBy('target_key', 'asc');
      if (lane === 'live') {
        query = query.whereIn('event_type', LIVE_EVENT_TYPES);
      } else if (lane === 'background') {
        query = query.whereNotIn('event_type', LIVE_EVENT_TYPES);
      }
      if (isPostgres(transaction)) {
        query = query.forUpdate().skipLocked();
      }
      const row = await query.first();
      if (!row) {
        return null;
      }

      const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
      const attemptCount = Number(row.attempt_count) + 1;
      await transaction(WEBHOOK_OUTBOX_TABLE)
        .where({
          event_id: row.event_id,
          target_key: row.target_key,
        })
        .update({
          status: 'delivering',
          attempt_count: attemptCount,
          lease_owner: workerId,
          lease_expires_at: leaseExpiresAt,
          first_attempt_at: row.first_attempt_at ?? now,
          last_attempt_at: now,
          updated_at: now,
        });
      return {
        ...row,
        attempt_count: attemptCount,
        status: 'delivering',
        lease_owner: workerId,
        lease_expires_at: leaseExpiresAt,
      } as WebhookOutboxRecord;
    });
  }

  async recoverExpiredLeases(): Promise<number> {
    const now = new Date();
    return this.knex(WEBHOOK_OUTBOX_TABLE)
      .where({ status: 'delivering' })
      .where('lease_expires_at', '<=', now)
      .update({
        status: 'retry',
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: now,
        last_error_class: 'lease_expired',
        last_error_code: 'worker_abandoned',
        updated_at: now,
      });
  }

  async delivered(
    record: WebhookOutboxRecord,
    attempt: WebhookAttempt,
  ): Promise<void> {
    await this.knex.transaction(async (transaction) => {
      await this.insertAttempt(transaction, attempt);
      const now = new Date();
      await transaction(WEBHOOK_OUTBOX_TABLE)
        .where({
          event_id: record.event_id,
          target_key: record.target_key,
          lease_owner: attempt.workerId,
        })
        .update({
          status: 'delivered',
          delivered_at: now,
          lease_owner: null,
          lease_expires_at: null,
          last_http_status: attempt.httpStatus ?? null,
          last_error_class: null,
          last_error_code: null,
          updated_at: now,
        });
    });
  }

  async retry(
    record: WebhookOutboxRecord,
    attempt: WebhookAttempt,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.finish(record, attempt, {
      status: 'retry',
      next_attempt_at: nextAttemptAt,
    });
  }

  async dead(
    record: WebhookOutboxRecord,
    attempt: WebhookAttempt,
  ): Promise<void> {
    await this.finish(record, attempt, {
      status: 'dead',
      dead_at: new Date(),
    });
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.knex(WEBHOOK_OUTBOX_TABLE)
      .select('status')
      .count({ count: '*' })
      .groupBy('status');
    return Object.fromEntries(
      rows.map((row) => [String(row.status), Number(row.count)]),
    );
  }

  async oldestPendingTimestamp(): Promise<number | null> {
    const row = await this.knex(WEBHOOK_OUTBOX_TABLE)
      .whereIn('status', ['pending', 'delivering', 'retry'])
      .min({ timestamp: 'event_timestamp_ms' })
      .first();
    if (row?.timestamp == null) {
      return null;
    }
    return Number(row.timestamp);
  }

  private async finish(
    record: WebhookOutboxRecord,
    attempt: WebhookAttempt,
    update: Record<string, unknown>,
  ): Promise<void> {
    await this.knex.transaction(async (transaction) => {
      await this.insertAttempt(transaction, attempt);
      await transaction(WEBHOOK_OUTBOX_TABLE)
        .where({
          event_id: record.event_id,
          target_key: record.target_key,
          lease_owner: attempt.workerId,
        })
        .update({
          ...update,
          lease_owner: null,
          lease_expires_at: null,
          last_http_status: attempt.httpStatus ?? null,
          last_error_class: attempt.errorClass ?? null,
          last_error_code: attempt.errorCode ?? null,
          updated_at: new Date(),
        });
    });
  }

  private insertAttempt(
    transaction: Knex.Transaction,
    attempt: WebhookAttempt,
  ): Promise<number[]> {
    return transaction(WEBHOOK_ATTEMPT_TABLE).insert({
      event_id: attempt.eventId,
      target_key: attempt.targetKey,
      attempt_number: attempt.attemptNumber,
      request_id: attempt.requestId,
      worker_id: attempt.workerId,
      started_at: attempt.startedAt,
      finished_at: attempt.finishedAt,
      outcome: attempt.outcome,
      http_status: attempt.httpStatus ?? null,
      error_class: attempt.errorClass ?? null,
      error_code: attempt.errorCode ?? null,
    });
  }
}
