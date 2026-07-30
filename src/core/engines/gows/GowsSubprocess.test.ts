import { GowsRuntimeState } from '@waha/core/engines/gows/GowsRuntimeState';
import { GowsSubprocess } from '@waha/core/engines/gows/GowsSubprocess';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

class FakeOutput extends EventEmitter {
  setEncoding = jest.fn();
}

class FakeChild extends EventEmitter {
  pid = 321;
  stdout = new FakeOutput();
  stderr = new FakeOutput();
  kill = jest.fn();
}

function buildLogger(): any {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  };
}

describe('GowsSubprocess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs structured worker evidence when GOWS exits unexpectedly', () => {
    const child = new FakeChild();
    (spawn as jest.Mock).mockReturnValue(child as any);
    const logger = buildLogger();
    const runtime = new GowsRuntimeState();
    const onExit = jest.fn();
    const subprocess = new GowsSubprocess(
      logger,
      '/app/gows',
      '/tmp/gows.sock',
      false,
      runtime,
      () => ({
        workerId: 'worker-one',
        activeSessions: 7,
      }),
    );

    subprocess.start(onExit);
    child.stderr.emit(
      'data',
      'ordinary diagnostic\nfatal error: out of memory',
    );
    child.emit('close', 137, null);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'gows.process.exit',
        workerId: 'worker-one',
        activeSessions: 7,
        code: 137,
        signal: null,
        expected: false,
        panicDetected: true,
        oomDetected: true,
        diagnosticEvidence: ['fatal error: out of memory'],
      }),
      'GOWS subprocess exited unexpectedly',
    );
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 137,
        expected: false,
        oomDetected: true,
      }),
    );
    expect(
      runtime.snapshot({ workerId: null, activeSessions: 0 }).worker.ready,
    ).toBe(false);
  });

  it('classifies a requested shutdown as an expected exit', async () => {
    const child = new FakeChild();
    (spawn as jest.Mock).mockReturnValue(child as any);
    const logger = buildLogger();
    const runtime = new GowsRuntimeState();
    const onExit = jest.fn();
    const subprocess = new GowsSubprocess(
      logger,
      '/app/gows',
      '/tmp/gows.sock',
      false,
      runtime,
      () => ({
        workerId: 'worker-one',
        activeSessions: 0,
      }),
    );

    subprocess.start(onExit);
    await subprocess.stop();
    child.emit('close', null, 'SIGTERM');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: 'SIGTERM',
        expected: true,
      }),
    );
    expect(
      runtime.snapshot({ workerId: null, activeSessions: 0 }),
    ).toMatchObject({
      worker: {
        ready: false,
        process: {
          status: 'stopped',
        },
      },
    });
  });
});
