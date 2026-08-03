import { stampEventMetadata } from '@waha/core/abc/event-metadata';

describe('stampEventMetadata', () => {
  it('creates independent webhook identities for the same provider message', () => {
    const providerMessage = {
      id: 'false_5511999999999@c.us_PROVIDER_MESSAGE_ID',
      body: '.',
      fromMe: false,
    };

    const messageEvent = stampEventMetadata(providerMessage);
    const messageAnyEvent = stampEventMetadata(providerMessage);

    expect(messageEvent).not.toBe(providerMessage);
    expect(messageAnyEvent).not.toBe(providerMessage);
    expect(messageEvent._eventId).not.toBe(messageAnyEvent._eventId);
    expect(messageEvent.id).toBe(providerMessage.id);
    expect(messageAnyEvent.id).toBe(providerMessage.id);
    expect(providerMessage).not.toHaveProperty('_eventId');
    expect(providerMessage).not.toHaveProperty('_timestampMs');
  });
});
