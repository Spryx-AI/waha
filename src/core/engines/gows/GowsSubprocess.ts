import {
  GowsProcessExit,
  GowsRuntimeContext,
  GowsRuntimeState,
} from '@waha/core/engines/gows/GowsRuntimeState';
import { sleep, waitUntil } from '@waha/utils/promiseTimeout';
import { spawn } from 'child_process';
import { Logger } from 'pino';

export type GowsRuntimeContextProvider = () => GowsRuntimeContext;

export class GowsSubprocess {
  private checkIntervalMs: number = 100;
  private readyDelayMs: number = 1_000;
  private readyText = 'gRPC server started!';

  private child: any;
  private ready: boolean = false;
  private stdoutBuffer: string = '';
  private stopping: boolean = false;
  private diagnosticEvidence: string[] = [];

  constructor(
    private logger: Logger,
    readonly path: string,
    readonly socket: string,
    readonly pprof: boolean,
    private runtime: GowsRuntimeState,
    private context: GowsRuntimeContextProvider,
  ) {}

  start(onExit: (exit: GowsProcessExit) => void) {
    this.logger.info('Starting GOWS subprocess...');
    this.logger.debug(`GOWS path '${this.path}', socket: '${this.socket}'...`);

    const args = ['--socket', this.socket];
    if (this.pprof) {
      this.logger.info('Debug mode enabled, adding pprof flags');
      args.push('--pprof');
      args.push('--pprof-port=6060');
      args.push('--pprof-host=0.0.0.0');
    }

    this.child = spawn(this.path, args, {
      detached: true,
    });
    this.runtime.markProcessStarting(this.child.pid ?? null);
    this.logger.debug(`GOWS started with PID: ${this.child.pid}`);
    this.child.on('close', (code, signal) => {
      const exit = this.buildExit(code, signal);
      this.runtime.markProcessExit(exit);
      const context = this.context();
      const evidence = {
        event: 'gows.process.exit',
        workerId: context.workerId,
        activeSessions: context.activeSessions,
        code: exit.code,
        signal: exit.signal,
        expected: exit.expected,
        panicDetected: exit.panicDetected,
        oomDetected: exit.oomDetected,
        diagnosticEvidence: exit.diagnosticEvidence,
      };
      if (exit.expected) {
        this.logger.info(evidence, 'GOWS subprocess stopped');
      } else {
        this.logger.error(evidence, 'GOWS subprocess exited unexpectedly');
      }
      onExit(exit);
    });
    this.child.on('error', (err) => {
      this.runtime.markProcessError(err);
      const context = this.context();
      this.logger.error(
        {
          event: 'gows.process.error',
          workerId: context.workerId,
          activeSessions: context.activeSessions,
          err: err,
        },
        'GOWS subprocess error',
      );
    });

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      this.captureDiagnosticEvidence(text);
      this.logger.error(text);
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (data) => {
      this.handleStdout(data.toString());
    });
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    const parts = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = parts.pop() ?? '';
    parts.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      this.log(trimmed);
      void this.checkReady(trimmed);
    });
    void this.checkReady(this.stdoutBuffer);
  }

  private async checkReady(text: string) {
    if (this.ready || !text.includes(this.readyText)) {
      return;
    }
    await sleep(this.readyDelayMs);
    this.ready = true;
    this.runtime.markProcessReady();
    const context = this.context();
    this.logger.info(
      {
        event: 'gows.process.ready',
        workerId: context.workerId,
        activeSessions: context.activeSessions,
        pid: this.child?.pid ?? null,
      },
      'GOWS is ready',
    );
  }

  async waitWhenReady(timeout: number) {
    const started = await waitUntil(
      async () => this.ready,
      this.checkIntervalMs,
      timeout,
    );
    if (!started) {
      const msg = `GOWS did not start after ${timeout} ms`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }

  async stop() {
    this.logger.info('Stopping GOWS subprocess...');
    this.stopping = true;
    this.runtime.markProcessStopping();
    this.child?.kill('SIGTERM');
  }

  private log(msg) {
    if (msg.startsWith('ERROR | ')) {
      this.logger.error(msg.slice(8));
    } else if (msg.startsWith('WARN | ')) {
      this.logger.warn(msg.slice(7));
    } else if (msg.startsWith('INFO | ')) {
      this.logger.info(msg.slice(7));
    } else if (msg.startsWith('DEBUG | ')) {
      this.logger.debug(msg.slice(8));
    } else if (msg.startsWith('TRACE | ')) {
      this.logger.trace(msg.slice(8));
    } else {
      this.logger.info(msg);
    }
  }

  private captureDiagnosticEvidence(text: string): void {
    const diagnosticPattern = /panic|fatal error|out of memory|\boom\b|cannot allocate memory/i;
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => diagnosticPattern.test(line))
      .map((line) => line.slice(0, 512));
    this.diagnosticEvidence.push(...lines);
    this.diagnosticEvidence = this.diagnosticEvidence.slice(-5);
  }

  private buildExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): GowsProcessExit {
    const evidence = [...this.diagnosticEvidence];
    return {
      code: code,
      signal: signal,
      timestamp: Date.now(),
      expected: this.stopping,
      panicDetected: evidence.some((line) => /panic|fatal error/i.test(line)),
      oomDetected: evidence.some((line) =>
        /out of memory|\boom\b|cannot allocate memory/i.test(line),
      ),
      diagnosticEvidence: evidence,
    };
  }
}
