import { Rules } from "./chess/rules.ts";
import { defaultEngineOptions, Engine } from "./engine/engine.ts";
import { threadsAvailable } from "./engine/transport.ts";
import { PlayController } from "./play/controller.ts";
import { analysisScreen } from "./screens/analysis.ts";
import { bookScreen } from "./screens/book.ts";
import { exploreScreen } from "./screens/explore.ts";
import { playScreen } from "./screens/play.ts";
import { progressScreen } from "./screens/progress.ts";
import { settingsScreen } from "./screens/settings.ts";
import { setupScreen } from "./screens/setup.ts";
import { startContributions } from "./book/contrib-client.ts";
import { checkMasterAtStartup } from "./book/master.ts";
import { loadSettings } from "./settings.ts";
import { startShell } from "./ui/shell.ts";
import "./styles/tokens.css";
import "./styles/base.css";

const userSettings = await loadSettings();
const rules = await Rules.load();
const controller = new PlayController(rules);
await controller.restore();

// Shown on the Play screen until the engine is ready.
let engineStatus: string | null = "Downloading engine…";
const setStatus = (s: string | null) => {
  engineStatus = s;
  controller.refresh();
};

startShell({
  play: playScreen(controller, () => engineStatus),
  setup: setupScreen(rules, controller),
  analysis: analysisScreen(rules, controller, () => engineStatus),
  progress: progressScreen(controller),
  book: bookScreen(),
  settings: settingsScreen(controller),
  explore: exploreScreen(rules, controller),
});

// The human-like opponent is downloaded when a game against it starts.
controller.humanLoader = (profile) => Engine.startHuman(profile);

// A newer master opening book on the server: merge it (setting) or ask, once per version.
checkMasterAtStartup(() => window.dispatchEvent(new Event("book-changed")));

// Deep searches waiting to go to the master book (if this browser contributes).
startContributions();

// The threaded engine first; if it does not start (seen on an iPad after hours in the
// background, until the browser was restarted), the single-threaded one.
const defaults = defaultEngineOptions();
const options = { threads: userSettings.threads ?? defaults.threads, hashMb: userSettings.hashMb ?? defaults.hashMb };
const progress = (loaded: number, total: number) =>
  setStatus(total ? `Downloading engine… ${Math.round((loaded / total) * 100)}%` : "Downloading engine…");

async function startEngine(threaded: boolean): Promise<Engine> {
  const engine = await Engine.start(threaded ? options : { ...options, threads: 1 }, progress, threaded);
  setStatus("Preparing engine…");
  try {
    await engine.warmUp();
  } catch (err) {
    engine.close();
    throw err;
  }
  return engine;
}

try {
  let engine: Engine;
  try {
    engine = await startEngine(threadsAvailable());
  } catch (err) {
    if (!threadsAvailable()) throw err;
    console.warn("threaded engine failed, trying the single-threaded one:", err);
    setStatus("Starting the engine again…");
    engine = await startEngine(false);
  }
  setStatus(null);
  controller.attachEngine(engine);
} catch (err) {
  console.error(err);
  setStatus(`The engine could not be started (${err instanceof Error ? err.message : err}). Closing and reopening the browser may help.`);
}
