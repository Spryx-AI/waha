import { generatePrefixedId } from '@waha/utils/ids';

export function stampEventMetadata(data: any): any {
  return {
    ...data,
    _eventId: generatePrefixedId('evt'),
    _timestampMs: Date.now(),
  };
}
