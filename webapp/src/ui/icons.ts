// Line icons, 24 x 24, drawn with the current text colour.
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  flip: svg('<path d="M7 4v16"/><path d="m3 8 4-4 4 4"/><path d="M17 20V4"/><path d="m13 16 4 4 4-4"/>'),
  menu: svg('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  first: svg('<path d="M6 5v14"/><path d="m18 6-6 6 6 6"/>'),
  prev: svg('<path d="m15 6-6 6 6 6"/>'),
  next: svg('<path d="m9 6 6 6-6 6"/>'),
  last: svg('<path d="M18 5v14"/><path d="m6 6 6 6-6 6"/>'),
  play: svg('<path d="M7 5v14l11-7z"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
  hint: svg('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>'),
  evaluation: svg('<path d="M4 20h16"/><path d="M7 16V10"/><path d="M12 16V5"/><path d="M17 16v-4"/>'),
  bookmark: svg('<path d="M6 3h12v18l-6-4.5L6 21z"/>'),
  bookmarked: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="bookmark-shape" d="M6 3h12v18l-6-4.5L6 21z"/></svg>`,
  starLit:`<svg viewBox="0 0 24 24" aria-hidden="true"><path class="star-shape" d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>`,
  starOut: svg('<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/>'),
};
