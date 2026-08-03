import { populateSessionInfo } from '@waha/core/abc/manager.abc';
import { WhatsappSession } from '@waha/core/abc/session.abc';
import { WebhookSender } from '@waha/core/integrations/webhooks/WebhookSender';
import { WebhookOutbox } from '@waha/core/integrations/webhooks/WebhookOutbox';
import { WebhookTarget } from '@waha/core/integrations/webhooks/WebhookTarget';
import { WAHAEvents, WAHAEventsWild } from '@waha/structures/enums.dto';
import { WebhookConfig } from '@waha/structures/webhooks.config.dto';
import { EventWildUnmask } from '@waha/utils/events';
import { LoggerBuilder } from '@waha/utils/logging';
import { Logger } from 'pino';

export class WebhookConductor {
  private logger: Logger;
  private eventUnmask = new EventWildUnmask(WAHAEvents, WAHAEventsWild);

  constructor(
    protected loggerBuilder: LoggerBuilder,
    private outbox?: WebhookOutbox,
  ) {
    this.logger = loggerBuilder.child({ name: WebhookConductor.name });
  }

  protected buildSender(webhookConfig: WebhookConfig): WebhookSender {
    return new WebhookSender(this.loggerBuilder, webhookConfig);
  }

  private getSuitableEvents(events: WAHAEvents[] | string[]): WAHAEvents[] {
    return this.eventUnmask.unmask(events);
  }

  public configure(session: WhatsappSession, webhooks: WebhookTarget[]) {
    for (const target of webhooks) {
      this.configureSingleWebhook(session, target);
    }
  }

  private configureSingleWebhook(
    session: WhatsappSession,
    target: WebhookTarget,
  ) {
    const webhook = target.config;
    if (!webhook || !webhook.url || webhook.events.length === 0) {
      return;
    }

    const url = webhook.url;
    this.logger.info(`Configuring webhooks for ${url}...`);
    const events = this.getSuitableEvents(webhook.events);
    const sender = this.buildSender(webhook);
    this.outbox?.register(target, sender);
    for (const event of events) {
      const obs$ = session.getEventObservable(event);
      obs$.subscribe((payload) => {
        setImmediate(() => {
          const data = populateSessionInfo(event, session)(payload);
          if (this.outbox) {
            void this.outbox.enqueue(target, data).catch((error) => {
              this.logger.error(
                {
                  event: 'webhook.outbox.persist_failed',
                  eventId: data.id,
                  session: data.session,
                  eventType: data.event,
                  targetKey: target.key,
                  err: error,
                },
                'Webhook could not be persisted; delivery was not attempted',
              );
            });
            return;
          }
          sender.send(data);
        });
      });
      this.logger.debug(`Event '${event}' is enabled for url: ${url}`);
    }
    this.logger.info(`Webhooks were configured for ${url}.`);
  }
}
