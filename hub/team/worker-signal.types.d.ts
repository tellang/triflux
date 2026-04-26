export type WorkerSignal =
  | { type: "start"; shardId: string; ts: string }
  | {
      type: "heartbeat";
      shardId: string;
      ts: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: "done";
      shardId: string;
      ts: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "error";
      shardId: string;
      ts: string;
      reason: string;
      meta?: Record<string, unknown>;
    };

export type WorkerSignalEvent =
  | WorkerSignal
  | {
      type: "stale";
      shardId: string;
      ts: string;
      lastTs: string;
      timeoutMs: number;
    };

export class WorkerSignalChannel {
  constructor(options: {
    shardId: string;
    signalDir: string;
    timeoutMs?: number;
    now?: () => number;
  });
  start(): Promise<void>;
  heartbeat(meta?: Record<string, unknown>): Promise<void>;
  done(payload: Record<string, unknown>): Promise<void>;
  error(reason: string, meta?: Record<string, unknown>): Promise<void>;
  static listen(options: {
    signalDir: string;
    onSignal: (signal: WorkerSignalEvent) => void;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
  }): Promise<void>;
}
