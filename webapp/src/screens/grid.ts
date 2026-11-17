// The analysis grid screen (#/grid), "Explore" in the navigation: see grid/grid-app.ts. Also
// reached from the Analysis screen ("Explore from here") and from Setup ("Explore"). On
// phones it shows the board with the lines as moves instead of the grid.
import type { Rules } from "../chess/rules.ts";
import { mountGrid } from "../grid/grid-app.ts";
import type { PlayController } from "../play/controller.ts";
import type { Screen } from "../ui/shell.ts";

export function gridScreen(rules: Rules, controller: PlayController, engineStatus: () => string | null): Screen {
  return {
    mount(root) {
      let cleanup: (() => void) | null = null;
      let left = false;
      mountGrid(root, rules, controller, engineStatus).then((c) => {
        if (left) c(); // left the screen while it was loading
        else cleanup = c;
      });
      return () => {
        left = true;
        cleanup?.();
      };
    },
  };
}
