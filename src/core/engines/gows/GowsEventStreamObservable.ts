import * as grpc from '@grpc/grpc-js';
import { rand } from '@waha/core/auth/config';
import { messages } from '@waha/core/engines/gows/grpc/gows';
import { GowsEventStreamLifecycle } from '@waha/core/engines/gows/GowsRuntimeState';
import { EnginePayload } from '@waha/structures/webhooks.dto';
import { sleep } from '@waha/utils/promiseTimeout';
import { Logger } from 'pino';
import { Observable } from 'rxjs';

/**
 * Raised when the gRPC stream ends without an error.
 * The engine event stream is expected to live as long as the session,
 * so a clean end still means we lost the events and have to reconnect.
 */
export class GowsStreamEndedError extends Error {
  constructor() {
    super('gRPC event stream ended');
    this.name = 'GowsStreamEndedError';
  }
}

/**
 * Observable that listens to a gRPC stream and emits EnginePayload objects.
 * Pass a factory function that returns a client and a stream.
 *
 * The observable always terminates with an error, never with a completion,
 * so that an upstream retry() reconnects the stream.
 */
export class GowsEventStreamObservable extends Observable<EnginePayload> {
  _client: grpc.Client;
  CLIENT_CLOSE_TIMEOUT = 1_000;

  constructor(
    logger: Logger,
    factory: () => {
      client: grpc.Client;
      stream: grpc.ClientReadableStream<messages.EventJson>;
    },
    lifecycle?: GowsEventStreamLifecycle,
  ) {
    super((subscriber) => {
      logger.info(
        { event: 'gows.stream.connecting' },
        'Creating gRPC event stream',
      );
      lifecycle?.connecting();
      logger.setBindings({ id: rand() });
      const { client, stream } = factory();
      this._client = client;
      const closeTimeout = this.CLIENT_CLOSE_TIMEOUT;

      let closed = false;
      let terminated = false;
      let tearingDown = false;
      let ready = false;

      function markReady() {
        if (ready) {
          return;
        }
        ready = true;
        lifecycle?.ready();
        logger.info({ event: 'gows.stream.ready' }, 'gRPC event stream ready');
      }

      async function cleanup(reason: string) {
        if (closed) {
          return;
        }
        closed = true;

        logger.debug({ reason: reason }, 'Cancelling gRPC stream...');
        try {
          stream.cancel();
        } catch (err) {
          logger.warn({ err: err }, 'Failed to cancel gRPC stream');
        }

        logger.debug({ reason: reason }, 'Closing gRPC client...');
        try {
          client.close();
        } catch (err) {
          logger.warn({ err: err }, 'Failed to close gRPC client');
        }

        await sleep(closeTimeout);
      }

      // Must run synchronously from the stream handlers.
      // grpc-js calls stream.push(null) - which schedules 'end' on the next tick -
      // and only then emits 'error' in the same tick. Erroring the subscriber
      // right away wins that race, otherwise 'end' completes the observable
      // and the upstream retry() never reconnects.
      function terminate(err: Error) {
        if (terminated) {
          return;
        }
        terminated = true;
        // Erroring the subscriber runs the teardown below, which cleans up.
        subscriber.error(err);
      }

      stream.on('data', (raw) => {
        markReady();
        setImmediate(() => {
          const obj = raw.toObject();
          obj.data = JSON.parse(obj.data);
          subscriber.next(obj);
        });
      });

      stream.on('metadata', () => {
        markReady();
      });

      stream.on('end', () => {
        if (tearingDown || terminated) {
          logger.debug('Stream ended');
          return;
        }
        const error = new GowsStreamEndedError();
        lifecycle?.interrupted(error);
        logger.error(
          {
            event: 'gows.stream.interrupted',
            reason: 'ended',
          },
          'gRPC event stream ended unexpectedly; reconnecting',
        );
        terminate(error);
      });

      stream.on('error', (err: any) => {
        if (tearingDown || terminated) {
          // We cancelled the stream ourselves, no need to reconnect
          logger.debug({ err: err }, 'Stream cancelled by client');
          return;
        }
        lifecycle?.interrupted(err);
        logger.error(
          {
            event: 'gows.stream.interrupted',
            reason: 'error',
            code: err?.code ?? null,
            err: err,
          },
          'gRPC event stream error; reconnecting',
        );
        terminate(err);
      });

      return () => {
        tearingDown = true;
        void cleanup('teardown');
      };
    });
  }

  get client(): Omit<grpc.Client, 'close'> {
    return this._client;
  }
}
