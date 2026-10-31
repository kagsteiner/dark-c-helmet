import { Rules } from "./chess/rules.ts";
import { Engine } from "./engine/engine.ts";
import { PlayController } from "./play/controller.ts";
import { playScreen } from "./screens/play.ts";
import { placeholder, startShell } from "./ui/shell.ts";
import "./styles/tokens.css";
import "./styles/base.css";

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
  setup: placeholder("Setup", "Setting up positions comes in milestone M3."),
  analysis: placeholder("Analysis", "Analysis comes in milestone M4."),
  book: placeholder("Opening book", "The opening book comes in milestone M5."),
  settings: placeholder("Settings", "Settings come in milestone M6."),
});

try {
  const engine = await Engine.start(undefined, (loaded, total) => {
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
