#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = required('WAHA_CANARY_BASE_URL').replace(/\/+$/, '');
const apiKey = required('WAHA_CANARY_API_KEY');
const session = required('WAHA_CANARY_SESSION');
const chatId = required('WAHA_CANARY_CHAT_ID');
const timeoutMs = Number(process.env.WAHA_CANARY_TIMEOUT_MS ?? 180_000);
const runId = `spryx-${Date.now()}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'X-Api-Key': apiKey,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${path} returned ${response.status}: ${text}`,
    );
  }
  return body;
}

async function post(path, body) {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function newMessageId() {
  const result = await request(
    `/api/${encodeURIComponent(session)}/new-message-id`,
  );
  if (!result?.id) {
    throw new Error(`WAHA did not generate a message id: ${JSON.stringify(result)}`);
  }
  return result.id;
}

function assertResponseId(name, response, rawId) {
  if (!response?.id || !response.id.includes(rawId)) {
    throw new Error(
      `${name} did not preserve generated id ${rawId}: ${JSON.stringify(response)}`,
    );
  }
  return response.id;
}

function file(path, mimetype, filename) {
  return {
    mimetype: mimetype,
    filename: filename,
    data: readFileSync(path).toString('base64'),
  };
}

function createFixtures() {
  return {
    image: file(join(root, 'examples/waha.jpg'), 'image/jpeg', 'waha.jpg'),
    audio: file(join(root, 'examples/voice.mp3'), 'audio/mpeg', 'voice.mp3'),
    video: file(join(root, 'examples/video.mp4'), 'video/mp4', 'video.mp4'),
    document: file(
      join(root, 'examples/example.pdf'),
      'application/pdf',
      'example.pdf',
    ),
  };
}

async function send(endpoint, name, body) {
  const rawId = await newMessageId();
  const response = await post(`/api/${endpoint}`, {
    session: session,
    chatId: chatId,
    id: rawId,
    ...body,
  });
  return assertResponseId(name, response, rawId);
}

async function waitForWorking() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await request(`/api/sessions/${encodeURIComponent(session)}`);
    if (current?.status === 'WORKING') {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Session ${session} did not reach WORKING`);
}

async function waitForHistory(expectedIds) {
  const deadline = Date.now() + timeoutMs;
  const encodedSession = encodeURIComponent(session);
  const encodedChat = encodeURIComponent(chatId);
  while (Date.now() < deadline) {
    const messages = await request(
      `/api/${encodedSession}/chats/${encodedChat}/messages?limit=100&downloadMedia=true`,
    );
    const ids = new Set(messages.map((message) => message.id));
    if (expectedIds.every((id) => ids.has(id))) {
      return messages;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Sent messages were not all visible in bounded history');
}

async function main() {
  await waitForWorking();
  const readiness = await request('/health/ready');
  if (
    readiness?.status !== 'ok' ||
    readiness?.info?.['gows.runtime']?.worker?.ready !== true
  ) {
    throw new Error(`GOWS is not ready: ${JSON.stringify(readiness)}`);
  }

  const fixtures = createFixtures();
  const ids = {};
  ids.text = await send('sendText', 'text', {
    text: `Spryx WAHA text canary ${runId}`,
  });
  ids.image = await send('sendImage', 'image', {
    caption: runId,
    file: fixtures.image,
  });
  ids.audio = await send('sendVoice', 'audio', {
    file: fixtures.audio,
    convert: true,
  });
  ids.video = await send('sendVideo', 'video', {
    caption: runId,
    file: fixtures.video,
    convert: false,
  });
  ids.document = await send('sendFile', 'document', {
    caption: runId,
    file: fixtures.document,
  });
  ids.reply = await send('sendText', 'reply', {
    text: `Spryx WAHA reply canary ${runId}`,
    reply_to: ids.text,
  });

  await waitForHistory(Object.values(ids));

  if (process.env.WAHA_CANARY_TEST_SESSION_RESTART === '1') {
    await post(`/api/sessions/${encodeURIComponent(session)}/restart`);
    await waitForWorking();
    await waitForHistory(Object.values(ids));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        runId: runId,
        session: session,
        chatId: chatId,
        ids: ids,
        sessionRestart:
          process.env.WAHA_CANARY_TEST_SESSION_RESTART === '1'
            ? 'passed'
            : 'not-requested',
      },
      null,
      2,
    )}\n`,
  );
}

await main();
