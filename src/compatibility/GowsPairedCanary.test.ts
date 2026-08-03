import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

const execute = promisify(execFile);

describe('spryx-paired-gows canary harness', () => {
  it('exercises every send contract, history, readiness and session restart', async () => {
    const sent: Array<{ endpoint: string; body: any }> = [];
    let generated = 0;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
          : null;
        response.setHeader('Content-Type', 'application/json');

        if (request.url === '/health/ready') {
          response.end(
            JSON.stringify({
              status: 'ok',
              info: { 'gows.runtime': { worker: { ready: true } } },
            }),
          );
          return;
        }
        if (request.url === '/api/sessions/canary') {
          response.end(JSON.stringify({ status: 'WORKING' }));
          return;
        }
        if (request.url === '/api/canary/new-message-id') {
          generated += 1;
          response.end(JSON.stringify({ id: `raw-${generated}` }));
          return;
        }
        if (request.url === '/api/sessions/canary/restart') {
          response.end(JSON.stringify({ status: 'STARTING' }));
          return;
        }
        if (request.url?.startsWith('/api/send')) {
          sent.push({ endpoint: request.url, body: body });
          response.end(
            JSON.stringify({
              id: `true_5511999999999@c.us_${body.id}`,
            }),
          );
          return;
        }
        if (request.url?.startsWith('/api/canary/chats/')) {
          response.end(
            JSON.stringify(
              sent.map((item) => ({
                id: `true_5511999999999@c.us_${item.body.id}`,
              })),
            ),
          );
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await execute(
        process.execPath,
        [path.resolve('scripts/spryx-paired-gows.mjs')],
        {
          env: {
            ...process.env,
            WAHA_CANARY_BASE_URL: `http://127.0.0.1:${port}`,
            WAHA_CANARY_API_KEY: 'test-key',
            WAHA_CANARY_SESSION: 'canary',
            WAHA_CANARY_CHAT_ID: '5511999999999@c.us',
            WAHA_CANARY_TEST_SESSION_RESTART: '1',
            WAHA_CANARY_TIMEOUT_MS: '5000',
          },
        },
      );
      const report = JSON.parse(result.stdout);

      expect(report).toMatchObject({
        session: 'canary',
        chatId: '5511999999999@c.us',
        sessionRestart: 'passed',
      });
      expect(sent.map((item) => item.endpoint)).toEqual([
        '/api/sendText',
        '/api/sendImage',
        '/api/sendVoice',
        '/api/sendVideo',
        '/api/sendFile',
        '/api/sendText',
      ]);
      expect(sent.map((item) => item.body.id)).toEqual([
        'raw-1',
        'raw-2',
        'raw-3',
        'raw-4',
        'raw-5',
        'raw-6',
      ]);
      expect(sent[5].body.reply_to).toContain('raw-1');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
