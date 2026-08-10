import { IMediaEngineProcessor } from '@waha/core/media/IMediaEngineProcessor';
import { IMediaStorage, MediaData } from '@waha/core/media/IMediaStorage';
import { MediaManager } from '@waha/core/media/MediaManager';
import { Logger } from 'pino';

describe('MediaManager', () => {
  it('uses the canonical .mov extension and preserves the QuickTime MIME type', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const storage = ({
      exists: jest.fn().mockResolvedValue(false),
      save: save,
      getStorageData: jest.fn().mockResolvedValue({
        url: 'https://media.example/message.mov',
      }),
    } as unknown) as IMediaStorage;
    const processor = ({
      hasMedia: jest.fn().mockReturnValue(true),
      getMessageId: jest.fn().mockReturnValue('message-1'),
      getChatId: jest.fn().mockReturnValue('5511999999999@c.us'),
      getFilename: jest.fn().mockReturnValue(undefined),
      getMimetype: jest.fn().mockReturnValue('video/quicktime'),
      getMediaBuffer: jest.fn().mockResolvedValue(Buffer.from('quicktime')),
    } as unknown) as IMediaEngineProcessor<unknown>;
    const logger = ({
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      trace: jest.fn(),
    } as unknown) as Logger;
    const manager = new MediaManager(storage, [], logger);

    await manager.processMedia(processor, {}, 'session-1');

    expect(save).toHaveBeenCalledTimes(1);
    const media = save.mock.calls[0][1] as MediaData;
    expect(media.file).toEqual({
      extension: 'mov',
      filename: undefined,
      mimetype: 'video/quicktime',
    });
  });
});
