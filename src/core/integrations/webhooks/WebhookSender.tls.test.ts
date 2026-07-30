import {
  WebhookAgents,
  WebhookSender,
} from '@waha/core/integrations/webhooks/WebhookSender';
import { WAHAEvents } from '@waha/structures/enums.dto';
import { LoggerBuilder } from '@waha/utils/logging';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

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

function webhook(url: string) {
  return new WebhookSender(buildLogger(), {
    url: url,
    events: [WAHAEvents.MESSAGE_ANY],
  });
}

describe('WebhookSender TLS verification', () => {
  let directory: string;
  let certificate: Buffer;
  let key: Buffer;
  let server: https.Server;
  let port: number;

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waha-tls-'));
    const certificatePath = path.join(directory, 'certificate.pem');
    const keyPath = path.join(directory, 'key.pem');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ]);
    certificate = fs.readFileSync(certificatePath);
    key = fs.readFileSync(keyPath);
    server = https.createServer(
      { cert: certificate, key: key },
      (_request, response) => {
        response.writeHead(202);
        response.end();
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('accepts a valid certificate from the configured trusted CA', async () => {
    const agents: WebhookAgents = {
      http: new http.Agent(),
      https: new https.Agent({ ca: certificate, rejectUnauthorized: true }),
    };
    const sender = new WebhookSender(
      buildLogger(),
      {
        url: `https://localhost:${port}/waha`,
        events: [WAHAEvents.MESSAGE_ANY],
      },
      agents,
    );

    await expect(
      sender.sendOnce({
        id: 'evt_valid',
        timestamp: Date.now(),
        event: WAHAEvents.MESSAGE_ANY,
      }),
    ).resolves.toMatchObject({ status: 202 });
  });

  it('rejects a certificate whose hostname does not match', async () => {
    const agents: WebhookAgents = {
      http: new http.Agent(),
      https: new https.Agent({ ca: certificate, rejectUnauthorized: true }),
    };
    const sender = new WebhookSender(
      buildLogger(),
      {
        url: `https://127.0.0.1:${port}/waha`,
        events: [WAHAEvents.MESSAGE_ANY],
      },
      agents,
    );

    await expect(
      sender.sendOnce({
        id: 'evt_invalid_hostname',
        timestamp: Date.now(),
        event: WAHAEvents.MESSAGE_ANY,
      }),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });

  it('rejects an untrusted self-signed certificate by default', async () => {
    const sender = webhook(`https://localhost:${port}/waha`);

    await expect(
      sender.sendOnce({
        id: 'evt_untrusted',
        timestamp: Date.now(),
        event: WAHAEvents.MESSAGE_ANY,
      }),
    ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });
});
