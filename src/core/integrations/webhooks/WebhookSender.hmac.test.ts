import { WebhookSender } from '@waha/core/integrations/webhooks/WebhookSender';
import { WAHAEvents } from '@waha/structures/enums.dto';
import { LoggerBuilder } from '@waha/utils/logging';
import * as crypto from 'node:crypto';

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

class TestWebhookSender extends WebhookSender {
  hmacHeaders(body: string, timestamp: string) {
    return this.getHMACHeaders(body, timestamp);
  }

  webhookHeaders() {
    return this.getWebhookHeader();
  }
}

describe('WebhookSender HMAC', () => {
  it('binds the timestamp and exact body in version 2 signatures', () => {
    const sender = new TestWebhookSender(buildLogger(), {
      url: 'https://channel-events.example.com/waha',
      events: [WAHAEvents.MESSAGE_ANY],
      hmac: { key: 'test-secret' },
    });
    const body = '{"event":"message.any"}';
    const timestamp = '1785276000000';

    const headers = sender.hmacHeaders(body, timestamp);

    expect(headers).toEqual({
      'X-Webhook-Hmac': crypto
        .createHmac('sha512', 'test-secret')
        .update(`${timestamp}.${body}`)
        .digest('hex'),
      'X-Webhook-Hmac-Algorithm': 'sha512',
      'X-Webhook-Hmac-Version': '2',
    });
  });

  it('signs the delivery attempt time instead of a stale event time', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1785276000123);
    const sender = new TestWebhookSender(buildLogger(), {
      url: 'https://channel-events.example.com/waha',
      events: [WAHAEvents.MESSAGE_ANY],
      hmac: { key: 'test-secret' },
    });

    expect(sender.webhookHeaders()).toMatchObject({
      'X-Webhook-Timestamp': '1785276000123',
    });
  });
});
