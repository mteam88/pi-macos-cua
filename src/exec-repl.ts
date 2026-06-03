import repl from "node:repl";
import { inspect } from "node:util";
import { PassThrough, Writable } from "node:stream";

export interface ExecReplEvaluation {
  value: unknown;
  logs: string[];
  stateKeys: string[];
}

export class ExecReplError extends Error {
  constructor(
    message: string,
    public readonly logs: string[],
    public readonly stateKeys: string[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExecReplError";
  }
}

interface EvaluateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  resetState?: boolean;
  context?: Record<string, unknown>;
  filename?: string;
}

export class PersistentExecRepl {
  private readonly replServer = this.createReplServer();
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    this.replServer.context.state = {};
  }

  async evaluateBody(code: string, options: EvaluateOptions = {}): Promise<ExecReplEvaluation> {
    const run = async (): Promise<ExecReplEvaluation> => {
      if (options.resetState) {
        this.clearState();
      }

      const logs: string[] = [];
      let stateKeys: string[] = [];
      const additions = {
        ...(options.context ?? {}),
        console: createConsoleProxy(logs),
        state: this.ensureStateObject(),
        clearState: () => this.clearState(),
      } satisfies Record<string, unknown>;

      const restore = this.applyContext(additions);
      try {
        const wrapped = wrapBody(code);
        const evaluated = await withTimeoutAndAbort(
          this.evalCode(wrapped, options.filename ?? "macos-cua-exec"),
          options.timeoutMs ?? 30_000,
          options.signal,
        );
        const value = await withTimeoutAndAbort(Promise.resolve(evaluated), options.timeoutMs ?? 30_000, options.signal);
        stateKeys = this.snapshotState();
        return {
          value,
          logs,
          stateKeys,
        };
      } catch (error) {
        stateKeys = this.snapshotState();
        throw new ExecReplError(error instanceof Error ? error.message : String(error), logs, stateKeys, { cause: error });
      } finally {
        restore();
        this.ensureStateObject();
      }
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  clearState(): void {
    const state = this.ensureStateObject();
    for (const key of Object.keys(state)) {
      delete state[key];
    }
  }

  private createReplServer(): repl.REPLServer {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    return repl.start({
      prompt: "",
      input,
      output,
      terminal: false,
      useGlobal: false,
      ignoreUndefined: true,
    });
  }

  private evalCode(code: string, filename: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.replServer.eval(code, this.replServer.context, filename, (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });
  }

  private applyContext(values: Record<string, unknown>): () => void {
    const previous = new Map<string, { existed: boolean; value: unknown }>();
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, {
        existed: Object.prototype.hasOwnProperty.call(this.replServer.context, key),
        value: this.replServer.context[key],
      });
      this.replServer.context[key] = value;
    }

    return () => {
      for (const [key, snapshot] of previous.entries()) {
        if (snapshot.existed) {
          this.replServer.context[key] = snapshot.value;
        } else {
          delete this.replServer.context[key];
        }
      }
    };
  }

  private ensureStateObject(): Record<string, unknown> {
    if (!isPlainObject(this.replServer.context.state)) {
      this.replServer.context.state = {};
    }
    return this.replServer.context.state as Record<string, unknown>;
  }

  private snapshotState(): string[] {
    const state = this.ensureStateObject();
    let cloned: unknown;
    try {
      cloned = structuredClone(state);
    } catch {
      throw new Error("macos_cua_exec state must contain only structured-cloneable data. Avoid storing functions, promises, or live handles in state.");
    }

    if (!isPlainObject(cloned)) {
      throw new Error("macos_cua_exec state must remain an object.");
    }

    this.replServer.context.state = cloned;
    return Object.keys(cloned);
  }
}

function wrapBody(code: string): string {
  return `(async () => {\n"use strict";\n${code}\n})()`;
}

function createConsoleProxy(logs: string[]) {
  const push = (...args: unknown[]) => {
    logs.push(args.map(formatValue).join(" "));
  };

  return {
    log: push,
    info: push,
    warn: push,
    error: push,
    debug: push,
    dir: (value: unknown) => push(value),
  };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(value, { depth: 5, colors: false, breakLength: 100 });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeoutAndAbort<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`macos_cua_exec timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      const reason = signal?.reason;
      if (reason instanceof Error) {
        reject(reason);
        return;
      }
      reject(new Error(typeof reason === "string" ? reason : "Cancelled"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
