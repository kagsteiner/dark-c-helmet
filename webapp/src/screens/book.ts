// The Book screen: what the opening book holds, export to a file, merge a file, clear.
import { clearBook, exportBook, mergeBook, stats, type BookStats } from "../book/book.ts";
import { describeMerge, fetchManifest, formatBytes, installedMaster, mergeMaster } from "../book/master.ts";
import type { MasterManifest } from "../book/master-format.ts";
import { settings, updateSettings } from "../settings.ts";
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

          <h2 class="section-title">Master book</h2>
          <p class="muted">A book built with the engine on a fast computer and published with this app.
            Merging it adds its moves to yours; your own deeper searches are kept.</p>
          <p class="master-installed"></p>
          <div class="book-actions">
            <button class="btn-secondary" data-action="check">Check for a new version</button>
            <button class="btn-secondary" data-action="master" hidden></button>
          </div>
          <label class="check"><input type="checkbox" name="autoMergeMaster"${settings().autoMergeMaster ? " checked" : ""}>
            Merge new versions automatically</label>
          <p class="master-status small" aria-live="polite"></p>
        </section>`;
      const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
      const section = $<HTMLElement>(".book");
      const status = (text: string, error = false) => {
        const el = $(".book-status");
        el.textContent = text;
        el.classList.toggle("error", error);
      };

      // Master book: what this device has, what the server offers.
      let offered: MasterManifest | null = null;
      const renderMaster = async (checked = false) => {
        const inst = await installedMaster();
        $(".master-installed").textContent = inst
          ? `Merged here: version ${inst.version} of ${new Date(inst.created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${inst.moves.toLocaleString("en")} moves.`
          : "Not merged on this device yet.";
        const btn = $<HTMLButtonElement>('[data-action="master"]');
        const newer = offered && offered.version > (inst?.version ?? 0);
        btn.hidden = !newer;
        if (newer) btn.textContent = `Merge version ${offered!.version} (${formatBytes(offered!.bytes)})`;
        if (checked) $(".master-status").textContent = offered ? (newer ? "" : "You have the newest version.") : "No master book is published yet.";
      };
      const checkMaster = async (showResult: boolean) => {
        offered = await fetchManifest();
        renderMaster(showResult);
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
        } else if (action === "check") {
          $(".master-status").textContent = "Checking…";
          checkMaster(true);
        } else if (action === "master" && offered) {
          const btn = $<HTMLButtonElement>('[data-action="master"]');
          btn.disabled = true;
          try {
            const r = await mergeMaster(offered, (f) => ($(".master-status").textContent = `Downloading… ${Math.round(f * 100)}%`));
            $(".master-status").textContent = "Merged: " + describeMerge(r);
          } catch (err) {
            $(".master-status").textContent = err instanceof Error ? err.message : String(err);
          }
          btn.disabled = false;
          renderMaster();
          render();
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

      section.addEventListener("change", (e) => {
        const t = e.target as HTMLInputElement;
        if (t.name === "autoMergeMaster") updateSettings({ autoMergeMaster: t.checked });
      });
      // A merge started elsewhere (the question at startup) changes what is shown here.
      const onBookChanged = () => {
        render();
        renderMaster();
      };
      window.addEventListener("book-changed", onBookChanged);

      render();
      checkMaster(false);
      return () => window.removeEventListener("book-changed", onBookChanged);
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
