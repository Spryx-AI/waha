import * as grpc from '@grpc/grpc-js';
import {
  GowsEventStreamObservable,
  GowsStreamEndedError,
} from '@waha/core/engines/gows/GowsEventStreamObservable';
import { GowsRuntimeState } from '@waha/core/engines/gows/GowsRuntimeState';
import { EventEmitter } from 'events';
import { merge, Subject } from 'rxjs';
import { retry } from 'rxjs/operators';

/**
 * Mimics grpc.ClientReadableStream.
 * The important part is failWithStatus - it reproduces what grpc-js does in
 * client.js makeServerStreamRequest.onReceiveStatus on a non OK status:
 * push(null) schedules 'end' on the next tick, then 'error' is emitted
 * synchronously in the current tick.
 */
class FakeStream extends EventEmitter {
  public cancelled = false;

  cancel() {
    this.cancelled = true;
  }

  failWithStatus(err: any) {
    process.nextTick(() => this.emit('end'));
    this.emit('error', err);
  }

  endCleanly() {
    process.nextTick(() => this.emit('end'));
  }
}

class FakeClient {
  public closed = false;

  close() {
    this.closed = true;
  }
}

function buildLogger(): any {
  function noop() {
    return undefined;
  }
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    setBindings: noop,
  };
}

function drainTicks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function observe(stream: FakeStream, client: FakeClient) {
  const observable = new GowsEventStreamObservable(buildLogger(), () => ({
    client: client as any,
    stream: stream as any,
  }));
  // Do not wait a real second for the client to close
  observable.CLIENT_CLOSE_TIMEOUT = 0;

  const next = jest.fn();
  const error = jest.fn();
  const complete = jest.fn();
  const subscription = observable.subscribe({
    next: next,
    error: error,
    complete: complete,
  });
  return {
    next: next,
    error: error,
    complete: complete,
    subscription: subscription,
  };
}

describe('GowsEventStreamObservable', () => {
  it('errors (not completes) when the stream fails with a non OK status', async () => {
    const stream = new FakeStream();
    const client = new FakeClient();
    const { error, complete } = observe(stream, client);

    const err = { code: grpc.status.UNAVAILABLE, message: 'unavailable' };
    stream.failWithStatus(err);
    await drainTicks();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(err);
    expect(complete).not.toHaveBeenCalled();
    expect(stream.cancelled).toBe(true);
    expect(client.closed).toBe(true);
  });

  it('errors (not completes) when the stream ends cleanly', async () => {
    const stream = new FakeStream();
    const client = new FakeClient();
    const { error, complete } = observe(stream, client);

    stream.endCleanly();
    await drainTicks();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBeInstanceOf(GowsStreamEndedError);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not error when we cancel the stream ourselves', async () => {
    const stream = new FakeStream();
    const client = new FakeClient();
    const { error, complete, subscription } = observe(stream, client);

    subscription.unsubscribe();
    stream.emit('error', { code: grpc.status.CANCELLED });
    stream.emit('end');
    await drainTicks();

    expect(error).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(stream.cancelled).toBe(true);
    expect(client.closed).toBe(true);
  });

  it('reconnects via retry() when merged with a never ending subject', async () => {
    const streams = [new FakeStream(), new FakeStream()];
    const clients = [new FakeClient(), new FakeClient()];
    let attempt = 0;
    const runtime = new GowsRuntimeState();

    const observable = new GowsEventStreamObservable(
      buildLogger(),
      () => {
        const index = attempt;
        attempt += 1;
        return {
          client: clients[index] as any,
          stream: streams[index] as any,
        };
      },
      runtime.eventStreamLifecycle('session-one'),
    );
    observable.CLIENT_CLOSE_TIMEOUT = 0;

    const local$ = new Subject<any>();
    const next = jest.fn();
    const error = jest.fn();
    const subscription = merge(observable, local$)
      .pipe(retry({ delay: 1 }))
      .subscribe({ next: next, error: error });

    streams[0].failWithStatus({ code: grpc.status.INTERNAL });
    await drainTicks();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(attempt).toBe(2);
    expect(error).not.toHaveBeenCalled();

    streams[1].emit('data', {
      toObject: () => ({ event: 'Message', data: '{"id":"1"}' }),
    });
    await drainTicks();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toEqual({
      event: 'Message',
      data: { id: '1' },
    });
    expect(
      runtime.snapshot({ workerId: 'worker-one', activeSessions: 1 }),
    ).toMatchObject({
      eventStreams: {
        status: 'ready',
        sessions: {
          'session-one': {
            status: 'ready',
            attempts: 2,
            reconnects: 1,
            interruptions: 1,
          },
        },
      },
      counters: {
        streamReconnects: 1,
        streamInterruptions: 1,
      },
    });
    subscription.unsubscribe();
  });
});
