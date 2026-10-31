import { Rules } from "./chess/rules.ts";
import { defaultEngineOptions, Engine } from "./engine/engine.ts";
import { PlayController } from "./play/controller.ts";
import { analysisScreen } from "./screens/analysis.ts";
import { bookScreen } from "./screens/book.ts";
import { playScreen } from "./screens/play.ts";
import { settingsScreen } from "./screens/settings.ts";
import { setupScreen } from "./screens/setup.ts";
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
  analysis: analysisScreen(rules, controller),
  book: bookScreen(),
  settings: settingsScreen(controller),
});

// A newer master opening book on the server: merge it (setting) or ask, once per version.
checkMasterAtStartup(() => window.dispatchEvent(new Event("book-changed")));

try {
  const defaults = defaultEngineOptions();
  const options = { threads: userSettings.threads ?? defaults.threads, hashMb: userSettings.hashMb ?? defaults.hashMb };
  const engine = await Engine.start(options, (loaded, total) => {
    setStatus(total ? `Downloading engine… ${Math.round((loaded / total) * 100)}%` : "Downloading engine…");
  });
  setStatus("Preparing engine…");
  await engine.warmUp();
  setStatus(null);
  controller.attachEngine(engine);
} catch (err) {
  console.error(err);
  setStatus("The engine could not be started in this browser.");
}
