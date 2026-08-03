import {
  migrateOutboundCommands,
  OutboundCommandRepository,
} from '@waha/core/outbound/OutboundCommandRepository';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Knex, { Knex as KnexType } from 'knex';

describe('OutboundCommandRepository', () => {
  let directory: string;
  let knex: KnexType;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waha-command-'));
    knex = Knex({
      client: 'better-sqlite3',
      connection: { filename: path.join(directory, 'commands.sqlite3') },
      useNullAsDefault: true,
    });
    await migrateOutboundCommands(knex);
  });

  afterEach(async () => {
    await knex.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('returns the persisted provider response for the same command', async () => {
    const repository = new OutboundCommandRepository(knex);
    const first = await repository.claim('session', 'message-id', 'hash', 5000);
    expect(first).toEqual({ outcome: 'execute' });

    const response = { id: 'true_chat_message-id', ack: 0 };
    await repository.succeed('session', 'message-id', response);

    await expect(
      repository.claim('session', 'message-id', 'hash', 5000),
    ).resolves.toEqual({ outcome: 'cached', response: response });
  });

  it('does not execute a concurrent or ambiguous command twice', async () => {
    const repository = new OutboundCommandRepository(knex);
    await repository.claim('session', 'message-id', 'hash', 5000);

    await expect(
      repository.claim('session', 'message-id', 'hash', 5000),
    ).resolves.toEqual({ outcome: 'in_progress' });

    await repository.markUncertain('session', 'message-id');
    await expect(
      repository.claim('session', 'message-id', 'hash', 5000),
    ).resolves.toEqual({ outcome: 'uncertain' });
  });

  it('rejects reuse of an id with a different payload', async () => {
    const repository = new OutboundCommandRepository(knex);
    await repository.claim('session', 'message-id', 'first-hash', 5000);

    await expect(
      repository.claim('session', 'message-id', 'other-hash', 5000),
    ).resolves.toEqual({ outcome: 'payload_conflict' });
  });
});
