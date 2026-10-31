/// <reference lib="webworker" />
// Hosts the WebAssembly engine (public/engine/dh-engine*.js, built by engine/build.sh).
//
// Threaded build: the engine's UCI loop runs on its own pthread and waits for commands;
// wasm_send() queues a line and wakes it. Single-threaded build: wasm_pump() runs the loop
// over the queued lines and returns when they are done (a "go" blocks until the search ends).

interface EngineModule {
  ccall(name: string, returnType: null, argTypes: string[], args: unknown[]): void;
}

type EngineFactory = (options: {
  print: (line: string) => void;
  printErr: (line: string) => void;
  locateFile: (path: string) => string;
}) => Promise<EngineModule>;

let engine: EngineModule | null = null;
let threaded = false;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "init") {
    threaded = msg.threaded;
    const dir = new URL("engine/", msg.base).href;
    try {
      const url = dir + (threaded ? "dh-engine.js" : "dh-engine-st.js");
      const factory = (await import(/* @vite-ignore */ url)).default as EngineFactory;
      engine = await factory({
        print: (line) => self.postMessage({ type: "line", line }),
        printErr: (line) => console.warn("engine:", line),
        locateFile: (path) => dir + path,
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
