// The connection to a UCI engine: lines in, lines out. Everything above this (search
// requests, info parsing, the book) is the same for the WebAssembly engine in the browser
// and, later, the native engine on localhost.
export interface EngineTransport {
  /** False for the single-threaded fallback: it cannot see "stop" during a search. */
  readonly canStop: boolean;
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  close(): void;
}

/** Threads need SharedArrayBuffer, which browsers only allow on cross-origin isolated pages. */
export function threadsAvailable(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
}

type WorkerMessage = { type: "line"; line: string } | { type: "ready" } | { type: "error"; message: string };

/** The WebAssembly engine, running in a Web Worker. */
export class WasmEngineTransport implements EngineTransport {
  readonly canStop: boolean;
  private handlers: ((line: string) => void)[] = [];
  private worker: Worker;

  private constructor(worker: Worker, threaded: boolean) {
    this.worker = worker;
    this.canStop = threaded;
    worker.addEventListener("message", (e: MessageEvent<WorkerMessage>) => {
      if (e.data.type === "line") for (const h of this.handlers) h(e.data.line);
    });
  }

  static create(threaded = threadsAvailable()): Promise<WasmEngineTransport> {
    const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
    return new Promise((resolve, reject) => {
      const onMessage = (e: MessageEvent<WorkerMessage>) => {
        if (e.data.type === "ready") {
          worker.removeEventListener("message", onMessage);
          resolve(new WasmEngineTransport(worker, threaded));
        } else if (e.data.type === "error") {
          worker.terminate();
          reject(new Error(e.data.message));
        }
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ type: "init", threaded, base: new URL(import.meta.env.BASE_URL, location.href).href });
    });
  }

  send(line: string): void {
    this.worker.postMessage({ type: "cmd", line });
  }

  onLine(handler: (line: string) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.worker.terminate();
    this.handlers = [];
  }
}
