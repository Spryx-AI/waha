import { Injectable } from '@nestjs/common';

export type GowsProcessStatus =
  | 'disabled'
  | 'external'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type GowsEventStreamStatus = 'connecting' | 'ready' | 'degraded';
export type GowsSessionConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'unknown';

export interface GowsProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timestamp: number;
  expected: boolean;
  panicDetected: boolean;
  oomDetected: boolean;
  diagnosticEvidence: string[];
}

interface GowsProcessState {
  status: GowsProcessStatus;
  managed: boolean;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  errorAt: number | null;
  lastError: string | null;
  lastExit: GowsProcessExit | null;
}

interface GowsEventStreamState {
  status: GowsEventStreamStatus;
  attempts: number;
  reconnects: number;
  interruptions: number;
  connectingAt: number;
  readyAt: number | null;
  interruptedAt: number | null;
  lastError: string | null;
}

interface GowsSessionConnectionState {
  status: GowsSessionConnectionStatus;
  disconnects: number;
  restorations: number;
  changedAt: number;
  reason: string | null;
}

export interface GowsRuntimeContext {
  workerId: string | null;
  activeSessions: number;
}

export interface GowsRuntimeSnapshot {
  worker: {
    ready: boolean;
    id: string | null;
    activeSessions: number;
    process: GowsProcessState;
  };
  eventStreams: {
    status: 'ready' | 'connecting' | 'degraded';
    total: number;
    ready: number;
    connecting: number;
    degraded: number;
    sessions: Record<string, GowsEventStreamState>;
  };
  sessions: Record<string, GowsSessionConnectionState>;
  counters: {
    processStarts: number;
    processExits: number;
    streamConnections: number;
    streamReconnects: number;
    streamInterruptions: number;
    sessionDisconnects: number;
    sessionRestorations: number;
    keepaliveTimeouts: number;
    keepaliveRestores: number;
    slowListenerEventDrops: number;
    sessionStatusTransitions: number;
  };
}

export interface GowsEventStreamLifecycle {
  connecting(): void;
  ready(): void;
  interrupted(error: unknown): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error['message']);
  }
  return String(error);
}

@Injectable()
export class GowsRuntimeState {
  private process: GowsProcessState = {
    status: 'disabled',
    managed: false,
    pid: null,
    startedAt: null,
    readyAt: null,
    errorAt: null,
    lastError: null,
    lastExit: null,
  };

  private eventStreams = new Map<string, GowsEventStreamState>();
  private sessions = new Map<string, GowsSessionConnectionState>();

  private counters = {
    processStarts: 0,
    processExits: 0,
    streamConnections: 0,
    streamReconnects: 0,
    streamInterruptions: 0,
    sessionDisconnects: 0,
    sessionRestorations: 0,
    keepaliveTimeouts: 0,
    keepaliveRestores: 0,
    slowListenerEventDrops: 0,
    sessionStatusTransitions: 0,
  };

  markExternalReady(): void {
    const timestamp = Date.now();
    this.process = {
      status: 'external',
      managed: false,
      pid: null,
      startedAt: timestamp,
      readyAt: timestamp,
      errorAt: null,
      lastError: null,
      lastExit: null,
    };
  }

  markProcessStarting(pid: number | null): void {
    this.counters.processStarts += 1;
    this.process = {
      status: 'starting',
      managed: true,
      pid: pid,
      startedAt: Date.now(),
      readyAt: null,
      errorAt: null,
      lastError: null,
      lastExit: this.process.lastExit,
    };
  }

  markProcessReady(): void {
    this.process.status = 'ready';
    this.process.readyAt = Date.now();
    this.process.errorAt = null;
    this.process.lastError = null;
  }

  markProcessStopping(): void {
    this.process.status = 'stopping';
  }

  markProcessError(error: unknown): void {
    this.process.status = 'failed';
    this.process.errorAt = Date.now();
    this.process.lastError = errorMessage(error);
  }

  markProcessExit(exit: GowsProcessExit): void {
    this.counters.processExits += 1;
    this.process.status = exit.expected ? 'stopped' : 'failed';
    this.process.pid = null;
    this.process.errorAt = exit.expected ? null : exit.timestamp;
    this.process.lastError = exit.expected ? null : 'GOWS subprocess exited';
    this.process.lastExit = exit;
  }

  eventStreamLifecycle(session: string): GowsEventStreamLifecycle {
    return {
      connecting: () => this.markStreamConnecting(session),
      ready: () => this.markStreamReady(session),
      interrupted: (error: unknown) =>
        this.markStreamInterrupted(session, error),
    };
  }

  removeEventStream(session: string): void {
    this.eventStreams.delete(session);
  }

  markSessionConnected(session: string, reason: string): void {
    const previous = this.sessions.get(session);
    const restored = previous?.status === 'disconnected';
    if (restored) {
      this.counters.sessionRestorations += 1;
    }
    this.sessions.set(session, {
      status: 'connected',
      disconnects: previous?.disconnects ?? 0,
      restorations: (previous?.restorations ?? 0) + (restored ? 1 : 0),
      changedAt: Date.now(),
      reason: reason,
    });
  }

  markSessionDisconnected(session: string, reason: string): void {
    const previous = this.sessions.get(session);
    const disconnected = previous?.status !== 'disconnected';
    if (disconnected) {
      this.counters.sessionDisconnects += 1;
    }
    if (reason === 'keepalive_timeout') {
      this.counters.keepaliveTimeouts += 1;
    }
    this.sessions.set(session, {
      status: 'disconnected',
      disconnects: (previous?.disconnects ?? 0) + (disconnected ? 1 : 0),
      restorations: previous?.restorations ?? 0,
      changedAt: Date.now(),
      reason: reason,
    });
  }

  markKeepaliveRestored(session: string): void {
    this.counters.keepaliveRestores += 1;
    this.markSessionConnected(session, 'keepalive_restored');
  }

  markSlowListenerEventDrop(): void {
    this.counters.slowListenerEventDrops += 1;
  }

  markSessionStatusTransition(): void {
    this.counters.sessionStatusTransitions += 1;
  }

  removeSession(session: string): void {
    this.sessions.delete(session);
    this.removeEventStream(session);
  }

  snapshot(context: GowsRuntimeContext): GowsRuntimeSnapshot {
    const streams = Object.fromEntries(this.eventStreams.entries());
    const sessions = Object.fromEntries(this.sessions.entries());
    const values = Object.values(streams);
    const degraded = values.filter((stream) => stream.status === 'degraded')
      .length;
    const ready = values.filter((stream) => stream.status === 'ready').length;
    const connecting = values.filter((stream) => stream.status === 'connecting')
      .length;
    let streamStatus: GowsRuntimeSnapshot['eventStreams']['status'] = 'ready';
    if (connecting > 0) {
      streamStatus = 'connecting';
    }
    if (degraded > 0) {
      streamStatus = 'degraded';
    }

    return {
      worker: {
        ready: this.isWorkerReady(),
        id: context.workerId,
        activeSessions: context.activeSessions,
        process: structuredClone(this.process),
      },
      eventStreams: {
        status: streamStatus,
        total: values.length,
        ready: ready,
        connecting: connecting,
        degraded: degraded,
        sessions: structuredClone(streams),
      },
      sessions: structuredClone(sessions),
      counters: { ...this.counters },
    };
  }

  private isWorkerReady(): boolean {
    return (
      this.process.status === 'disabled' ||
      this.process.status === 'external' ||
      this.process.status === 'ready'
    );
  }

  private markStreamConnecting(session: string): void {
    const previous = this.eventStreams.get(session);
    const reconnecting = previous != null;
    if (reconnecting) {
      this.counters.streamReconnects += 1;
    }
    this.eventStreams.set(session, {
      status: 'connecting',
      attempts: (previous?.attempts ?? 0) + 1,
      reconnects: (previous?.reconnects ?? 0) + (reconnecting ? 1 : 0),
      interruptions: previous?.interruptions ?? 0,
      connectingAt: Date.now(),
      readyAt: previous?.readyAt ?? null,
      interruptedAt: previous?.interruptedAt ?? null,
      lastError: previous?.lastError ?? null,
    });
  }

  private markStreamReady(session: string): void {
    const previous = this.eventStreams.get(session);
    if (!previous || previous.status === 'ready') {
      return;
    }
    this.counters.streamConnections += 1;
    this.eventStreams.set(session, {
      ...previous,
      status: 'ready',
      readyAt: Date.now(),
      lastError: null,
    });
  }

  private markStreamInterrupted(session: string, error: unknown): void {
    const previous = this.eventStreams.get(session);
    this.counters.streamInterruptions += 1;
    this.eventStreams.set(session, {
      status: 'degraded',
      attempts: previous?.attempts ?? 1,
      reconnects: previous?.reconnects ?? 0,
      interruptions: (previous?.interruptions ?? 0) + 1,
      connectingAt: previous?.connectingAt ?? Date.now(),
      readyAt: previous?.readyAt ?? null,
      interruptedAt: Date.now(),
      lastError: errorMessage(error),
    });
  }
}
