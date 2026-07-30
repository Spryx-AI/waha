import { GowsRuntimeState } from '@waha/core/engines/gows/GowsRuntimeState';

const CONTEXT = {
  workerId: 'worker-one',
  activeSessions: 2,
};

describe('GowsRuntimeState', () => {
  it('keeps the shared worker ready when one session disconnects', () => {
    const runtime = new GowsRuntimeState();
    runtime.markProcessStarting(123);
    runtime.markProcessReady();
    runtime.markSessionConnected('session-one', 'connected');

    runtime.markSessionDisconnected('session-one', 'disconnected');

    const snapshot = runtime.snapshot(CONTEXT);
    expect(snapshot.worker.ready).toBe(true);
    expect(snapshot.worker.process.status).toBe('ready');
    expect(snapshot.sessions['session-one']).toMatchObject({
      status: 'disconnected',
      disconnects: 1,
      reason: 'disconnected',
    });
    expect(snapshot.counters.sessionDisconnects).toBe(1);
  });

  it('reports a shared worker failure after an unexpected process exit', () => {
    const runtime = new GowsRuntimeState();
    runtime.markProcessStarting(123);
    runtime.markProcessReady();

    runtime.markProcessExit({
      code: 137,
      signal: null,
      timestamp: 123456,
      expected: false,
      panicDetected: false,
      oomDetected: true,
      diagnosticEvidence: ['fatal error: out of memory'],
    });

    const snapshot = runtime.snapshot(CONTEXT);
    expect(snapshot.worker.ready).toBe(false);
    expect(snapshot.worker.process.status).toBe('failed');
    expect(snapshot.worker.process.lastExit).toEqual({
      code: 137,
      signal: null,
      timestamp: 123456,
      expected: false,
      panicDetected: false,
      oomDetected: true,
      diagnosticEvidence: ['fatal error: out of memory'],
    });
    expect(snapshot.counters.processExits).toBe(1);
  });

  it('tracks a degraded event stream until a reconnect becomes ready', () => {
    const runtime = new GowsRuntimeState();
    const lifecycle = runtime.eventStreamLifecycle('session-one');

    lifecycle.connecting();
    lifecycle.ready();
    lifecycle.interrupted(new Error('stream unavailable'));

    let snapshot = runtime.snapshot(CONTEXT);
    expect(snapshot.eventStreams.status).toBe('degraded');
    expect(snapshot.eventStreams.sessions['session-one']).toMatchObject({
      status: 'degraded',
      attempts: 1,
      reconnects: 0,
      interruptions: 1,
      lastError: 'stream unavailable',
    });

    lifecycle.connecting();
    lifecycle.ready();

    snapshot = runtime.snapshot(CONTEXT);
    expect(snapshot.eventStreams.status).toBe('ready');
    expect(snapshot.eventStreams.sessions['session-one']).toMatchObject({
      status: 'ready',
      attempts: 2,
      reconnects: 1,
      interruptions: 1,
      lastError: null,
    });
    expect(snapshot.counters.streamReconnects).toBe(1);
    expect(snapshot.counters.streamInterruptions).toBe(1);
  });

  it('counts dropped listener events and session status transitions', () => {
    const runtime = new GowsRuntimeState();

    runtime.markSlowListenerEventDrop();
    runtime.markSessionStatusTransition();
    runtime.markSessionStatusTransition();

    const snapshot = runtime.snapshot(CONTEXT);
    expect(snapshot.counters.slowListenerEventDrops).toBe(1);
    expect(snapshot.counters.sessionStatusTransitions).toBe(2);
  });
});
