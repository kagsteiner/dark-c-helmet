// The app frame: top bar with navigation (inline links on wide screens, a menu on phones)
// and the view area. Screens are chosen by the URL hash (#/play, #/setup, ...).
import { icons } from "./icons.ts";
import "../styles/shell.css";

export interface Screen {
  /** Builds the screen into `root`. Returns a cleanup function, called when leaving it. */
  mount(root: HTMLElement): (() => void) | void;
}

const ROUTES = [
  { path: "play", label: "Play" },
  { path: "setup", label: "Setup" },
  { path: "analysis", label: "Analysis" },
  { path: "book", label: "Book" },
  { path: "settings", label: "Settings" },
] as const;

/** Reached through a link in Settings, not the navigation. */
const OTHER_ROUTES = ["explore"] as const;

export type Route = (typeof ROUTES)[number]["path"] | (typeof OTHER_ROUTES)[number];

export function startShell(screens: Record<Route, Screen>): void {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/play">Dark C. Helmet</a>
      <nav class="nav-links" aria-label="Main">
        ${ROUTES.map((r) => `<a href="#/${r.path}" data-route="${r.path}">${r.label}</a>`).join("")}
      </nav>
      <button class="btn-icon nav-toggle" aria-label="Menu" aria-expanded="false">${icons.menu}</button>
    </header>
    <nav class="nav-sheet" aria-label="Main" hidden>
      ${ROUTES.map((r) => `<a href="#/${r.path}" data-route="${r.path}">${r.label}</a>`).join("")}
    </nav>
    <main class="view"></main>`;

  const view = app.querySelector<HTMLElement>(".view")!;
  const sheet = app.querySelector<HTMLElement>(".nav-sheet")!;
  const toggle = app.querySelector<HTMLButtonElement>(".nav-toggle")!;
  const setSheet = (open: boolean) => {
    sheet.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.innerHTML = open ? icons.close : icons.menu;
  };
  toggle.addEventListener("click", () => setSheet(sheet.hidden === true));
  sheet.addEventListener("click", () => setSheet(false));
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!sheet.hidden && !sheet.contains(t) && !toggle.contains(t)) setSheet(false);
  });

  let cleanup: (() => void) | void;
  const show = () => {
    const path = location.hash.replace(/^#\//, "").split("?")[0] as Route;
    const route = ROUTES.some((r) => r.path === path) || (OTHER_ROUTES as readonly string[]).includes(path) ? path : "play";
    for (const a of app.querySelectorAll<HTMLAnchorElement>("[data-route]")) {
      if (a.dataset.route === route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    cleanup?.();
    view.replaceChildren();
    view.dataset.screen = route;
    cleanup = screens[route].mount(view);
    setSheet(false);
  };
  window.addEventListener("hashchange", show);
  show();
}
