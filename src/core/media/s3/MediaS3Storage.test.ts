import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { MediaData } from '@waha/core/media/IMediaStorage';
import { MediaS3Storage } from '@waha/core/media/s3/MediaS3Storage';
import { MediaS3UrlResolver } from '@waha/core/media/s3/MediaS3UrlResolver';
import { Logger } from 'pino';

describe('MediaS3Storage', () => {
  it('stores the provider MIME type as the S3 Content-Type', async () => {
    const send = jest.fn().mockResolvedValue({});
    const client = ({ send: send } as unknown) as S3Client;
    const resolver = ({ resolve: jest.fn() } as unknown) as MediaS3UrlResolver;
    const logger = ({ debug: jest.fn() } as unknown) as Logger;
    const storage = new MediaS3Storage(client, resolver, 'waha-media', logger);
    const media: MediaData = {
      session: 'session-1',
      message: {
        id: 'message-1',
        chatId: '5511999999999@c.us',
      },
      file: {
        extension: 'mov',
        filename: undefined,
        mimetype: 'video/quicktime',
      },
    };

    await storage.save(Buffer.from('quicktime'), media);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: 'waha-media',
      Key: 'session-1/message-1.mov',
      ContentType: 'video/quicktime',
      Metadata: expect.objectContaining({
        'waha-media-mimetype': 'video/quicktime',
      }),
    });
  });
});
