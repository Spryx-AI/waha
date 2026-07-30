import { HealthCheckError } from '@nestjs/terminus';
import { GowsRuntimeState } from '@waha/core/engines/gows/GowsRuntimeState';
import { GowsRuntimeHealthIndicator } from '@waha/core/health/GowsRuntimeHealthIndicator';

const CONTEXT = {
  workerId: 'worker-one',
  activeSessions: 1,
};

describe('GowsRuntimeHealthIndicator', () => {
  it('keeps worker readiness up for a session-scoped disconnect', () => {
    const runtime = new GowsRuntimeState();
    runtime.markProcessStarting(123);
    runtime.markProcessReady();
    runtime.markSessionDisconnected('session-one', 'keepalive_timeout');
    const indicator = new GowsRuntimeHealthIndicator(runtime);

    const result = indicator.check('gows.runtime', CONTEXT);

    expect(result).toMatchObject({
      'gows.runtime': {
        status: 'up',
        worker: {
          ready: true,
          activeSessions: 1,
        },
        sessions: {
          'session-one': {
            status: 'disconnected',
            reason: 'keepalive_timeout',
          },
        },
      },
    });
  });

  it('reports readiness down for a shared GOWS process exit', () => {
    const runtime = new GowsRuntimeState();
    runtime.markProcessStarting(123);
    runtime.markProcessExit({
      code: 1,
      signal: null,
      timestamp: 123456,
      expected: false,
      panicDetected: false,
      oomDetected: false,
      diagnosticEvidence: [],
    });
    const indicator = new GowsRuntimeHealthIndicator(runtime);

    expect(() => indicator.check('gows.runtime', CONTEXT)).toThrow(
      HealthCheckError,
    );
  });
});
