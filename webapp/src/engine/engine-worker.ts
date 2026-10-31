/// <reference lib="webworker" />
// Hosts the WebAssembly engine (public/engine/dh-engine*.js, built by engine/build.sh).
//
// Threaded build: the engine's UCI loop runs on its own pthread and waits for commands;
// wasm_send() queues a line and wakes it. Single-threaded build: wasm_pump() runs the loop
// over the queued lines and returns when they are done (a "go" blocks until the search ends).
//
// The .wasm file is fetched here (not by the Emscripten loader) to report download progress.

interface EngineModule {
  ccall(name: string, returnType: null, argTypes: string[], args: unknown[]): void;
}

type EngineFactory = (options: {
  print: (line: string) => void;
  printErr: (line: string) => void;
  locateFile: (path: string) => string;
  instantiateWasm: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => void;
}) => Promise<EngineModule>;

let engine: EngineModule | null = null;
let threaded = false;

async function fetchWithProgress(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${response.status} ${url}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    self.postMessage({ type: "progress", loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes.buffer;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "init") {
    threaded = msg.threaded;
    const dir = new URL("engine/", msg.base).href;
    const name = msg.module ?? (threaded ? "dh-engine" : "dh-engine-st");
    try {
      const [factoryModule, bytes] = await Promise.all([
        import(/* @vite-ignore */ dir + name + ".js"),
        fetchWithProgress(dir + name + ".wasm"),
      ]);
      const module = await WebAssembly.compile(bytes);
      engine = await (factoryModule.default as EngineFactory)({
        print: (line) => self.postMessage({ type: "line", line }),
        printErr: (line) => console.warn("engine:", line),
        locateFile: (path) => dir + path,
        instantiateWasm: (imports, receive) => {
          WebAssembly.instantiate(module, imports).then((instance) => receive(instance, module));
        },
      });
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err) });
    }
  } else if (msg.type === "cmd" && engine) {
    engine.ccall("wasm_send", null, ["string"], [msg.line]);
    if (!threaded) engine.ccall("wasm_pump", null, [], []);
  }
};
