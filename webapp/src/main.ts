import { Rules } from "./chess/rules.ts";
import { playScreen } from "./screens/play.ts";
import { placeholder, startShell } from "./ui/shell.ts";
import "./styles/tokens.css";
import "./styles/base.css";

const rules = await Rules.load();

startShell({
  play: playScreen(rules),
  setup: placeholder("Setup", "Setting up positions comes in milestone M3."),
  analysis: placeholder("Analysis", "Analysis comes in milestone M4."),
  book: placeholder("Opening book", "The opening book comes in milestone M5."),
  settings: placeholder("Settings", "Settings come in milestone M6."),
});
