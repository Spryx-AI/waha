import {
  WebhookAttempt,
  WebhookOutboxRecord,
  WebhookOutboxRepository,
} from '@waha/core/integrations/webhooks/WebhookOutboxRepository';
import { WebhookSender } from '@waha/core/integrations/webhooks/WebhookSender';
import { WebhookTarget } from '@waha/core/integrations/webhooks/WebhookTarget';
import { WebhookConfig } from '@waha/structures/webhooks.config.dto';
import { LoggerBuilder } from '@waha/utils/logging';
import axios from 'axios';
import * as crypto from 'node:crypto';
import { Logger } from 'pino';

export interface WebhookOutboxOptions {
  workerId: string;
  concurrency?: number;
  retryConcurrency?: number;
  backgroundConcurrency?: number;
  pollMilliseconds?: number;
  leaseMilliseconds?: number;
  maxAttempts?: number;
  maxRetryAgeMilliseconds?: number;
}

export interface WebhookOutboxSnapshot {
  counts: Record<string, number>;
  oldestPendingAgeMs: number;
}

interface ClassifiedError {
  retryable: boolean;
  errorClass: string;
  errorCode: string;
  httpStatus: number | null;
  requestId: string | null;
}

export class WebhookOutbox {
  private logger: Logger;
  private targets = new Map<string, WebhookSender>();
  private liveTimer: NodeJS.Timeout | null = null;
  private backgroundTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private drainingLive = false;
  private drainingBackground = false;
  private drainingRetries = false;
  private stopped = true;
  private pollMilliseconds: number;
  private leaseMilliseconds: number;
  private maxAttempts: number;
  private maxRetryAgeMilliseconds: number;
  private liveConcurrency: number;
  private retryConcurrency: number;
  private backgroundConcurrency: number;

  constructor(
    private repository: WebhookOutboxRepository,
    private loggerBuilder: LoggerBuilder,
    private options: WebhookOutboxOptions,
  ) {
    this.logger = loggerBuilder.child({ name: WebhookOutbox.name });
    this.liveConcurrency = Math.max(1, options.concurrency ?? 8);
    this.retryConcurrency = Math.max(1, options.retryConcurrency ?? 2);
    this.backgroundConcurrency = Math.max(
      1,
      options.backgroundConcurrency ?? 1,
    );
    this.pollMilliseconds = options.pollMilliseconds ?? 1_000;
    this.leaseMilliseconds = options.leaseMilliseconds ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 100;
    this.maxRetryAgeMilliseconds =
      options.maxRetryAgeMilliseconds ?? 7 * 24 * 60 * 60 * 1_000;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.scheduleLive(0);
    this.scheduleBackground(0);
    this.scheduleRetries(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.liveTimer) {
      clearTimeout(this.liveTimer);
      this.liveTimer = null;
    }
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  register(target: WebhookTarget, sender: WebhookSender): void {
    this.targets.set(target.key, sender);
    this.scheduleLive(0);
    this.scheduleBackground(0);
    this.scheduleRetries(0);
  }

  async enqueue(target: WebhookTarget, webhook: any): Promise<void> {
    const body = JSON.stringify(webhook);
    const inserted = await this.repository.enqueue({
      eventId: webhook.id,
      targetKey: target.key,
      sessionName: webhook.session,
      eventType: webhook.event,
      eventTimestampMs: webhook.timestamp,
      targetConfig: target.config,
      payload: webhook,
      payloadSha256: crypto
        .createHash('sha256')
        .update(body)
        .digest('hex'),
    });
    this.logger.info(
      {
        event: 'webhook.outbox.persisted',
        eventId: webhook.id,
        session: webhook.session,
        eventType: webhook.event,
        targetKey: target.key,
        inserted: inserted,
      },
      'Webhook persisted before delivery',
    );
    this.scheduleLive(0);
    this.scheduleBackground(0);
  }

  async snapshot(): Promise<WebhookOutboxSnapshot> {
    const oldest = await this.repository.oldestPendingTimestamp();
    return {
      counts: await this.repository.counts(),
      oldestPendingAgeMs: oldest == null ? 0 : Math.max(0, Date.now() - oldest),
    };
  }

  private scheduleLive(delay: number): void {
    if (this.stopped || this.liveTimer) {
      return;
    }
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      void this.drainLive();
    }, delay);
    this.liveTimer.unref();
  }

  private scheduleBackground(delay: number): void {
    if (this.stopped || this.backgroundTimer) {
      return;
    }
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      void this.drainBackground();
    }, delay);
    this.backgroundTimer.unref();
  }

  private scheduleRetries(delay: number): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drainRetries();
    }, delay);
    this.retryTimer.unref();
  }

  private async drainLive(): Promise<void> {
    if (this.stopped || this.drainingLive) {
      return;
    }
    this.drainingLive = true;
    try {
      await this.drainLane('live', this.liveConcurrency);
    } catch (error) {
      this.logger.error(
        { event: 'webhook.outbox.live_dispatcher_error', err: error },
        'Live webhook outbox dispatcher failed',
      );
    } finally {
      this.drainingLive = false;
      this.scheduleLive(this.pollMilliseconds);
    }
  }

  private async drainBackground(): Promise<void> {
    if (this.stopped || this.drainingBackground) {
      return;
    }
    this.drainingBackground = true;
    try {
      await this.drainLane('background', this.backgroundConcurrency);
    } catch (error) {
      this.logger.error(
        { event: 'webhook.outbox.background_dispatcher_error', err: error },
        'Background webhook outbox dispatcher failed',
      );
    } finally {
      this.drainingBackground = false;
      this.scheduleBackground(this.pollMilliseconds);
    }
  }

  private async drainRetries(): Promise<void> {
    if (this.stopped || this.drainingRetries) {
      return;
    }
    this.drainingRetries = true;
    try {
      await this.repository.recoverExpiredLeases();
      await this.drainLane('retry', this.retryConcurrency);
    } catch (error) {
      this.logger.error(
        { event: 'webhook.outbox.retry_dispatcher_error', err: error },
        'Retry webhook outbox dispatcher failed',
      );
    } finally {
      this.drainingRetries = false;
      this.scheduleRetries(this.pollMilliseconds);
    }
  }

  private async drainLane(
    lane: 'live' | 'background' | 'retry',
    concurrency: number,
  ): Promise<void> {
    while (!this.stopped) {
      const records: WebhookOutboxRecord[] = [];
      for (let index = 0; index < concurrency; index += 1) {
        const record = await this.repository.claim(
          this.options.workerId,
          this.leaseMilliseconds,
          { lane: lane },
        );
        if (!record) {
          break;
        }
        records.push(record);
      }
      if (records.length === 0) {
        return;
      }
      await Promise.all(records.map((record) => this.deliver(record)));
    }
  }

  private async deliver(record: WebhookOutboxRecord): Promise<void> {
    const startedAt = new Date();
    const sender = this.resolveSender(record);
    if (!sender) {
      await this.fail(record, startedAt, {
        retryable: true,
        errorClass: 'target',
        errorCode: 'target_not_registered',
        httpStatus: null,
        requestId: null,
      });
      return;
    }

    const payload =
      typeof record.payload_json === 'string'
        ? JSON.parse(record.payload_json)
        : record.payload_json;
    try {
      const response = await sender.sendOnce(payload);
      const attempt = this.attempt(record, startedAt, {
        outcome: 'delivered',
        requestId: response.requestId,
        httpStatus: response.status,
      });
      await this.repository.delivered(record, attempt);
      this.logger.info(
        {
          event: 'webhook.outbox.delivered',
          eventId: record.event_id,
          session: record.session_name,
          targetKey: record.target_key,
          attempt: record.attempt_count,
          lagMs: Date.now() - Number(record.event_timestamp_ms),
        },
        'Webhook delivery acknowledged',
      );
    } catch (error) {
      await this.fail(record, startedAt, this.classify(error));
    }
  }

  private resolveSender(record: WebhookOutboxRecord): WebhookSender | null {
    const registered = this.targets.get(record.target_key);
    if (registered) {
      return registered;
    }
    if (!record.target_config_json) {
      return null;
    }
    let config: WebhookConfig;
    try {
      config =
        typeof record.target_config_json === 'string'
          ? JSON.parse(record.target_config_json)
          : record.target_config_json;
    } catch {
      return null;
    }
    if (!config?.url) {
      return null;
    }
    const sender = new WebhookSender(this.loggerBuilder, config);
    this.targets.set(record.target_key, sender);
    this.logger.info(
      {
        event: 'webhook.outbox.target_restored',
        targetKey: record.target_key,
      },
      'Webhook target restored from the durable event snapshot',
    );
    return sender;
  }

  private async fail(
    record: WebhookOutboxRecord,
    startedAt: Date,
    error: ClassifiedError,
  ): Promise<void> {
    const age = Date.now() - Number(record.event_timestamp_ms);
    const terminal =
      !error.retryable ||
      record.attempt_count >= this.maxAttempts ||
      age >= this.maxRetryAgeMilliseconds;
    const attempt = this.attempt(record, startedAt, {
      outcome: terminal ? 'dead' : 'retry',
      requestId: error.requestId,
      httpStatus: error.httpStatus,
      errorClass: error.errorClass,
      errorCode: error.errorCode,
    });
    if (terminal) {
      await this.repository.dead(record, attempt);
    } else {
      await this.repository.retry(
        record,
        attempt,
        new Date(Date.now() + this.retryDelay(record.attempt_count)),
      );
    }
    this.logger.warn(
      {
        event: terminal
          ? 'webhook.outbox.dead'
          : 'webhook.outbox.retry_scheduled',
        eventId: record.event_id,
        session: record.session_name,
        targetKey: record.target_key,
        attempt: record.attempt_count,
        errorClass: error.errorClass,
        errorCode: error.errorCode,
        httpStatus: error.httpStatus,
      },
      terminal
        ? 'Webhook moved to operator dead-letter'
        : 'Webhook retry scheduled',
    );
  }

  private retryDelay(attempt: number): number {
    const cap = Math.min(300_000, 2_000 * 2 ** Math.max(0, attempt - 1));
    return Math.max(100, Math.floor(Math.random() * cap));
  }

  private attempt(
    record: WebhookOutboxRecord,
    startedAt: Date,
    result: {
      outcome: string;
      requestId: string | null;
      httpStatus?: number | null;
      errorClass?: string | null;
      errorCode?: string | null;
    },
  ): WebhookAttempt {
    return {
      eventId: record.event_id,
      targetKey: record.target_key,
      attemptNumber: record.attempt_count,
      requestId: result.requestId,
      workerId: this.options.workerId,
      startedAt: startedAt,
      finishedAt: new Date(),
      outcome: result.outcome,
      httpStatus: result.httpStatus,
      errorClass: result.errorClass,
      errorCode: result.errorCode,
    };
  }

  private classify(error: unknown): ClassifiedError {
    if (!axios.isAxiosError(error)) {
      return {
        retryable: false,
        errorClass: 'local',
        errorCode: error instanceof Error ? error.name : 'unknown_error',
        httpStatus: null,
        requestId: null,
      };
    }
    const status = error.response?.status ?? null;
    const requestId =
      String(error.config?.headers?.['X-Webhook-Request-Id'] ?? '') || null;
    if (status != null) {
      return {
        retryable:
          status === 408 || status === 425 || status === 429 || status >= 500,
        errorClass: 'http',
        errorCode: `http_${status}`,
        httpStatus: status,
        requestId: requestId,
      };
    }
    return {
      retryable: true,
      errorClass: error.code?.includes('CERT') ? 'tls' : 'transport',
      errorCode: error.code ?? 'network_error',
      httpStatus: null,
      requestId: requestId,
    };
  }
}
