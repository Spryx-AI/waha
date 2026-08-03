import { Knex } from 'knex';

export const OUTBOUND_COMMAND_TABLE = 'waha_outbound_command';

export type OutboundCommandClaim =
  | { outcome: 'execute' }
  | { outcome: 'cached'; response: unknown }
  | { outcome: 'in_progress' }
  | { outcome: 'uncertain' }
  | { outcome: 'payload_conflict' };

function isPostgres(knex: Knex): boolean {
  return String(knex.client.config.client).includes('pg');
}

async function createSchema(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(OUTBOUND_COMMAND_TABLE)) {
    return;
  }
  await knex.schema.createTable(OUTBOUND_COMMAND_TABLE, (table) => {
    table.string('session_name', 128).notNullable();
    table.string('command_id', 128).notNullable();
    table.string('request_sha256', 64).notNullable();
    table.string('status', 16).notNullable();
    table.json('response_json').nullable();
    table.timestamp('lease_expires_at').nullable();
    table.timestamp('completed_at').nullable();
    table.timestamp('created_at').notNullable();
    table.timestamp('updated_at').notNullable();
    table.primary(['session_name', 'command_id']);
    table.index(['status', 'updated_at'], 'waha_outbound_command_status');
  });
}

export async function migrateOutboundCommands(knex: Knex): Promise<void> {
  if (!isPostgres(knex)) {
    await createSchema(knex);
    return;
  }
  await knex.transaction(async (transaction) => {
    await transaction.raw(
      "SELECT pg_advisory_xact_lock(hashtext('waha_outbound_command_v1'))",
    );
    await createSchema(transaction);
  });
}

function parseResponse(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return JSON.parse(value);
}

export class OutboundCommandRepository {
  constructor(private readonly knex: Knex) {}

  async claim(
    sessionName: string,
    commandId: string,
    requestSha256: string,
    leaseMilliseconds: number,
  ): Promise<OutboundCommandClaim> {
    return this.knex.transaction(async (transaction) => {
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
      const inserted = await transaction(OUTBOUND_COMMAND_TABLE)
        .insert({
          session_name: sessionName,
          command_id: commandId,
          request_sha256: requestSha256,
          status: 'processing',
          response_json: null,
          lease_expires_at: leaseExpiresAt,
          created_at: now,
          updated_at: now,
        })
        .onConflict(['session_name', 'command_id'])
        .ignore()
        .returning(['command_id']);
      if (inserted.length > 0) {
        return { outcome: 'execute' };
      }

      let query = transaction(OUTBOUND_COMMAND_TABLE).where({
        session_name: sessionName,
        command_id: commandId,
      });
      if (isPostgres(transaction)) {
        query = query.forUpdate();
      }
      const record = await query.first();
      if (record.request_sha256 !== requestSha256) {
        return { outcome: 'payload_conflict' };
      }
      if (record.status === 'succeeded') {
        return {
          outcome: 'cached',
          response: parseResponse(record.response_json),
        };
      }
      if (record.status === 'uncertain') {
        return { outcome: 'uncertain' };
      }
      if (new Date(record.lease_expires_at).getTime() <= now.getTime()) {
        await transaction(OUTBOUND_COMMAND_TABLE)
          .where({ session_name: sessionName, command_id: commandId })
          .update({
            status: 'uncertain',
            lease_expires_at: null,
            updated_at: now,
          });
        return { outcome: 'uncertain' };
      }
      return { outcome: 'in_progress' };
    });
  }

  async succeed(
    sessionName: string,
    commandId: string,
    response: unknown,
  ): Promise<void> {
    const now = new Date();
    await this.knex(OUTBOUND_COMMAND_TABLE)
      .where({
        session_name: sessionName,
        command_id: commandId,
        status: 'processing',
      })
      .update({
        status: 'succeeded',
        response_json: JSON.stringify(response ?? null),
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      });
  }

  async markUncertain(sessionName: string, commandId: string): Promise<void> {
    await this.knex(OUTBOUND_COMMAND_TABLE)
      .where({
        session_name: sessionName,
        command_id: commandId,
        status: 'processing',
      })
      .update({
        status: 'uncertain',
        lease_expires_at: null,
        updated_at: new Date(),
      });
  }
}
