// The easter egg of the Progress screen: once every Chess960 start position has been won
// against Dark C. Helmet, the tiles blast apart and reveal a portrait of Bobby Fischer, the
// inventor of Chess960. A click puts the tiles back. It is shown exactly once per device, or once
// per sync code when the devices are linked.
import fischerUrl from "../assets/fischer.webp";
import { load, save } from "../storage.ts";
import { EGG_KEY, notifyLocalChange } from "../sync/changes.ts";

/** Plays the egg if it has not been shown yet; otherwise does nothing. */
export async function fischerEggOnce(grid: SVGSVGElement): Promise<void> {
  if (await load<boolean>(EGG_KEY)) return;
  await save(EGG_KEY, true); // before showing, so it stays exactly once
  notifyLocalChange();
  await playFischerEgg(grid);
}

export async function playFischerEgg(grid: SVGSVGElement): Promise<void> {
  const img = new Image();
  img.src = fischerUrl;
  img.alt = "Bobby Fischer (1943–2008), creator of Chess960.";
  await img.decode().catch(() => {});

  grid.scrollIntoView({ block: "center" }); // the blast should be seen, also on a phone
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const triangles = [...grid.querySelectorAll<SVGPathElement>("g[data-n] path")];
  const frames = [...grid.querySelectorAll<SVGRectElement>("g[data-n] rect")];
  const box = grid.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const scale = grid.viewBox.baseVal.width / box.width; // screen pixels to SVG units
  const reach = Math.hypot(innerWidth, innerHeight) * scale;

  const root = document.documentElement;
  const overflow = root.style.overflow;
  root.style.overflow = "hidden"; // the flying tiles must not make the page scroll
  grid.classList.add("blasting");

  const fade = frames.map((r) => r.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }));
  const blast = triangles.map((t) => {
    const r = t.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
    const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.8;
    const dist = reach * (0.5 + Math.random() * 0.7);
    const spin = (Math.random() - 0.5) * 1440;
    const keyframes: Keyframe[] = still
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { transform: "none", opacity: 1 },
          { opacity: 1, offset: 0.65 },
          {
            transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) rotate(${spin}deg) scale(${0.5 + Math.random()})`,
            opacity: 0,
          },
        ];
    return t.animate(keyframes, {
      duration: still ? 400 : 1000 + Math.random() * 700,
      delay: still ? 0 : (1 - Math.hypot(dx, dy) / Math.hypot(box.width, box.height)) * 250,
      easing: "cubic-bezier(.15,.7,.3,1)",
      fill: "forwards",
    });
  });
  blast.push(...fade);

  const overlay = document.createElement("div");
  overlay.className = "fischer-egg";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "All 960 positions won against the engine");
  overlay.tabIndex = -1;
  overlay.append(img);
  const hint = document.createElement("p");
  hint.className = "small";
  hint.textContent = "All 960 positions won against Dark C. Helmet. Click to put the tiles back.";
  overlay.append(hint);
  document.body.append(overlay);
  const show = overlay.animate(
    [
      { opacity: 0, transform: "scale(.6)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    { duration: still ? 300 : 900, delay: still ? 0 : 350, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" },
  );
  overlay.focus();

  await new Promise<void>((resolve) => {
    const close = () => {
      overlay.removeEventListener("click", close);
      overlay.removeEventListener("keydown", onKey);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") close();
    };
    overlay.addEventListener("click", close);
    overlay.addEventListener("keydown", onKey);
  });

  // Back again: the image fades and the tiles fly home.
  show.updatePlaybackRate(2.5);
  show.reverse();
  for (const a of blast) {
    if (fade.includes(a)) continue; // the tile frames return once the triangles are home
    a.updatePlaybackRate(still ? 1 : 1.4);
    a.reverse();
  }
  await Promise.all([show, ...blast].map((a) => a.finished.catch(() => {})));
  overlay.remove();
  for (const a of blast) a.cancel();
  grid.classList.remove("blasting");
  root.style.overflow = overflow;
}
