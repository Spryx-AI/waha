import { SECOND } from '@waha/structures/enums.dto';
import {
  RetryPolicy,
  WebhookConfig,
} from '@waha/structures/webhooks.config.dto';
import { LoggerBuilder } from '@waha/utils/logging';
import { VERSION } from '@waha/version';
import axios, { AxiosInstance } from 'axios';
import axiosRetry, { retryAfter } from 'axios-retry';
import * as crypto from 'crypto';
import { Logger } from 'pino';
import { Agent as HttpAgentType } from 'node:http';
import { Agent as HttpsAgentType } from 'node:https';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const uniqid = require('uniqid');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HttpAgent = require('agentkeepalive');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HttpsAgent = require('agentkeepalive').HttpsAgent;

const DEFAULT_RETRY_DELAY_SECONDS = 2;
const DEFAULT_RETRY_ATTEMPTS = 15;
const DEFAULT_HMAC_ALGORITHM = 'sha512';

export interface WebhookAgents {
  http: HttpAgentType;
  https: HttpsAgentType;
}

function noDelay(_retryNumber = 0, error: any) {
  return Math.max(0, retryAfter(error));
}

function constantDelay(delayFactor: number) {
  return (_retryNumber = 0, error = undefined) => {
    return Math.max(delayFactor, retryAfter(error));
  };
}

export function exponentialDelay(delayFactor: number) {
  return (retryNumber = 0, error = undefined) => {
    const calculatedDelay = 2 ** retryNumber * delayFactor;
    const delay = Math.max(calculatedDelay, retryAfter(error));
    const randomSum = delay * 0.2 * Math.random(); // 0-20% of the delay
    return delay + randomSum;
  };
}

export class WebhookSender {
  protected static AGENTS = {
    http: new HttpAgent({}),
    https: new HttpsAgent({ rejectUnauthorized: true }),
  };

  protected url: string;
  protected logger: Logger;
  protected readonly config: WebhookConfig;

  protected axios: AxiosInstance;
  protected singleAttemptAxios: AxiosInstance;

  constructor(
    loggerBuilder: LoggerBuilder,
    protected webhookConfig: WebhookConfig,
    private agents: WebhookAgents = WebhookSender.AGENTS,
  ) {
    this.url = webhookConfig.url;
    this.logger = loggerBuilder.child({ name: WebhookSender.name });
    this.config = webhookConfig;
    this.axios = this.buildAxiosInstance();
    this.singleAttemptAxios = this.buildAxiosInstance(false);
  }

  send(json: any) {
    const body = JSON.stringify(json);
    const headers = {
      'content-type': 'application/json',
    };
    const webhookHeaders = this.getWebhookHeader();
    Object.assign(headers, webhookHeaders);
    Object.assign(
      headers,
      this.getHMACHeaders(body, webhookHeaders['X-Webhook-Timestamp']),
    );
    const ctx = {
      id: headers['X-Webhook-Request-Id'],
      ['event.id']: json.id,
      event: json.event,
      url: this.url,
    };
    this.logger.info(ctx, `Sending POST...`);
    this.logger.debug(ctx, `POST DATA`);

    this.axios
      .post(this.url, body, { headers: headers })
      .then((response) => {
        this.logger.info(
          ctx,
          `POST request was sent with status code: ${response.status}`,
        );
        this.logger.debug(
          {
            ...ctx,
            body: response.data,
          },
          `Response`,
        );
      })
      .catch((error) => {
        this.logger.error(
          {
            ...ctx,
            error: error.message,
            data: error.response?.data,
          },
          `POST request failed: ${error.message}`,
        );
      });
  }

  async sendOnce(
    json: any,
  ): Promise<{ status: number; requestId: string }> {
    const body = JSON.stringify(json);
    const headers = {
      'content-type': 'application/json',
    };
    const webhookHeaders = this.getWebhookHeader();
    Object.assign(headers, webhookHeaders);
    Object.assign(
      headers,
      this.getHMACHeaders(body, webhookHeaders['X-Webhook-Timestamp']),
    );
    const requestId = headers['X-Webhook-Request-Id'];
    const ctx = {
      id: requestId,
      ['event.id']: json.id,
      event: json.event,
      url: this.url,
    };
    this.logger.info(ctx, 'Sending durable webhook POST...');
    const response = await this.singleAttemptAxios.post(this.url, body, {
      headers: headers,
      maxRedirects: 0,
      timeout: 30_000,
    });
    this.logger.info(
      ctx,
      `Durable webhook POST was acknowledged with status code: ${response.status}`,
    );
    return { status: response.status, requestId: requestId };
  }

  protected buildAxiosInstance(retryEnabled: boolean = true): AxiosInstance {
    // configure headers
    const customHeaders = this.config.customHeaders || [];
    const headers = {
      'content-type': 'application/json',
      'User-Agent': `WAHA/${VERSION.version}`,
    };
    customHeaders.forEach((header) => {
      headers[header.name] = header.value;
    });

    // configure retry
    const attempts = this.config.retries?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
    const delaySeconds =
      this.config.retries?.delaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS;
    const delayMs = delaySeconds * SECOND;
    const policy = this.config.retries?.policy;
    const retryDelay = this.buildRetryDelay(policy, delayMs);

    const instance = axios.create({
      headers: headers,
      httpAgent: this.agents.http,
      httpsAgent: this.agents.https,
    });
    if (!retryEnabled) {
      return instance;
    }
    axiosRetry(instance, {
      retries: attempts,
      retryDelay: retryDelay,
      retryCondition: (error) => true,
      onRetry: (retryCount, error, requestConfig) => {
        this.logger.warn(
          {
            id: requestConfig.headers['X-Webhook-Request-Id'],
          },
          `Error sending POST request: '${error.message}'. Retrying ${retryCount}/${attempts}...`,
        );
      },
    });
    return instance;
  }

  protected getHMACHeaders(body: string, timestamp: string) {
    // HMAC
    const hmac = this.calculateHmac(
      `${timestamp}.${body}`,
      DEFAULT_HMAC_ALGORITHM,
    );
    if (!hmac) {
      return {};
    }
    return {
      'X-Webhook-Hmac': hmac,
      'X-Webhook-Hmac-Algorithm': DEFAULT_HMAC_ALGORITHM,
      'X-Webhook-Hmac-Version': '2',
    };
  }

  protected getWebhookHeader() {
    const timestamp = Date.now().toString();
    return {
      // UUID, no '-' in it
      'X-Webhook-Request-Id': uniqid(),
      // unix timestamp with ms
      'X-Webhook-Timestamp': timestamp,
    };
  }

  private calculateHmac(body, algorithm) {
    if (!this.config.hmac || !this.config.hmac.key) {
      return undefined;
    }

    return crypto
      .createHmac(algorithm, this.config.hmac.key)
      .update(body)
      .digest('hex');
  }

  private buildRetryDelay(
    policy: RetryPolicy | null,
    ms: number,
  ): (retryNumber: number, error: any) => number {
    if (!ms) {
      this.logger.debug(`Using no delay, because delaySeconds set to 0`);
      return noDelay;
    }

    switch (policy) {
      case RetryPolicy.CONSTANT:
        this.logger.debug(`Using constant delay with '${ms}' ms factor`);
        return constantDelay(ms);

      case RetryPolicy.LINEAR:
        this.logger.debug(`Using linear delay with '${ms}' ms factor`);
        return axiosRetry.linearDelay(ms);

      case RetryPolicy.EXPONENTIAL:
        this.logger.debug(`Using exponential delay with '${ms}' ms factor`);
        return exponentialDelay(ms);

      default:
        this.logger.debug('No delay policy specified, using constant delay');
        return constantDelay(ms);
    }
  }
}
