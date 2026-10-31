// The Book screen: what the opening book holds, export to a file, merge a file, clear.
import { clearBook, exportBook, mergeBook, stats, type BookStats } from "../book/book.ts";
import type { Screen } from "../ui/shell.ts";
import "../styles/book.css";

function formatNodes(n: number): string {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + " billion" : n >= 1e6 ? (n / 1e6).toFixed(1) + " million" : n.toLocaleString("en");
}

const SOURCE_NAMES: Record<string, string> = { game: "games", analysis: "analysis", seed: "seed book" };

export function bookScreen(): Screen {
  return {
    mount(root) {
      root.innerHTML = `
        <section class="page book">
          <h1 class="title">Opening book</h1>
          <p class="muted">The engine learns openings from its own searches. In a game it plays a book move
            when the book has one that was searched at least as long as it would search now; among
            moves within 0.1 pawns of each other it picks one at random. Positions up to move 20 of
            games from a standard or Chess960 start are kept.</p>
          <dl class="book-stats numeric"></dl>
          <div class="book-actions">
            <button class="btn-secondary" data-action="export">Export to file</button>
            <label class="btn-secondary file-button">Merge from file<input type="file" accept=".json,application/json" hidden></label>
            <button class="btn-secondary danger" data-action="clear">Clear book</button>
          </div>
          <p class="book-status small" aria-live="polite"></p>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      const section = $<HTMLElement>(".book");
      const status = (text: string, error = false) => {
        const el = $(".book-status");
        el.textContent = text;
        el.classList.toggle("error", error);
      };

      let current: BookStats | null = null;
      const render = async () => {
        current = await stats();
        const s = current;
        const list = (rec: Record<string, number>, names: Record<string, string> = {}) =>
          Object.entries(rec)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${names[k] ?? k}: ${v.toLocaleString("en")}`)
            .join(", ") || "–";
        $(".book-stats").innerHTML = `
          <dt>Positions</dt><dd>${s.positions.toLocaleString("en")}</dd>
          <dt>Moves</dt><dd>${s.moves.toLocaleString("en")}</dd>
          <dt>Deepest search</dt><dd>${s.moves ? formatNodes(s.maxNodes) + " nodes" : "–"}</dd>
          <dt>Learned from</dt><dd>${list(s.bySource, SOURCE_NAMES)}</dd>
          <dt>Nets</dt><dd>${list(s.byNet)}</dd>`;
        $<HTMLButtonElement>('[data-action="export"]').disabled = !s.moves;
        $<HTMLButtonElement>('[data-action="clear"]').disabled = !s.moves;
      };

      section.addEventListener("click", async (e) => {
        const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action === "export") {
          const blob = await exportBook();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `dark-c-helmet-book-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
          status(`Exported ${current?.moves.toLocaleString("en")} moves.`);
        } else if (action === "clear") {
          if (await confirmClear(current?.moves ?? 0)) {
            await clearBook();
            status("The book is empty.");
            render();
          }
        }
      });

      $<HTMLInputElement>('input[type="file"]').addEventListener("change", async (e) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = "";
        if (!file) return;
        status("Merging…");
        try {
          const r = await mergeBook(await file.text());
          status(
            `Merged: ${r.added.toLocaleString("en")} moves added, ${r.updated.toLocaleString("en")} replaced by deeper searches, ` +
              `${r.kept.toLocaleString("en")} kept` +
              (r.invalid ? `, ${r.invalid.toLocaleString("en")} invalid entries skipped.` : "."),
          );
        } catch (err) {
          status(err instanceof Error ? err.message : String(err), true);
        }
        render();
      });

      render();
    },
  };
}

function confirmClear(moves: number): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "sheet";
  dialog.innerHTML = `
    <form class="sheet-body" method="dialog">
      <h2 class="title">Clear the book?</h2>
      <p>All ${moves.toLocaleString("en")} moves will be deleted from this device. Export the book first if you may want it back.</p>
      <div class="sheet-actions">
        <button class="btn-secondary" value="cancel">Cancel</button>
        <button class="btn-primary danger" value="clear">Delete</button>
      </div>
    </form>`;
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "clear");
    });
    dialog.showModal();
  });
}
