// Line icons, 24 x 24, drawn with the current text colour.
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  flip: svg('<path d="M7 4v16"/><path d="m3 8 4-4 4 4"/><path d="M17 20V4"/><path d="m13 16 4 4 4-4"/>'),
  menu: svg('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
};
