// The line between the agent list and the terminal: drag it to resize the list,
// double-click it to fit the longest name. The width is this browser's own
// business, like collapsed folders. Upright the list is a top strip and the
// handle is hidden (style.css).
const WIDTH_KEY = 'remotty.tab-w';
const MIN_PX = 160;
const STEP_PX = 16; // arrow keys, for whoever resizes without a mouse

export function wireSidebar() {
  const tabs = document.getElementById('tabs');
  const handle = document.getElementById('tabs-resize');
  const root = document.documentElement.style;
  const clamp = (px) => Math.round(Math.min(Math.max(px, MIN_PX), innerWidth * 0.7));
  const set = (px) => {
    root.setProperty('--tab-w', `${clamp(px)}px`);
    handle.setAttribute('aria-valuenow', clamp(px));
    try { localStorage.setItem(WIDTH_KEY, clamp(px)); } catch {}
  };
  let saved = null;
  try { saved = Number(localStorage.getItem(WIDTH_KEY)); } catch {}
  if (saved) set(saved);

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no text selection while dragging
    handle.setPointerCapture(e.pointerId);
    const move = (m) => set(m.clientX - tabs.getBoundingClientRect().left);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', () => handle.removeEventListener('pointermove', move), { once: true });
  });
  handle.addEventListener('dblclick', () => set(fitWidth(tabs)));
  handle.addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    set(tabs.getBoundingClientRect().width + dir * STEP_PX);
  });
}

// Upright or narrow, the list is a drawer over the terminal (style.css), opened
// from the top bar. Picking an agent, the scrim or Esc closes it. On a wide
// screen the class does nothing: the list is always there.
export function wireDrawer() {
  const toggle = document.getElementById('menu');
  const set = (on) => {
    document.body.classList.toggle('drawer-open', on);
    toggle.setAttribute('aria-expanded', String(on));
  };
  const isOpen = () => document.body.classList.contains('drawer-open');
  toggle.addEventListener('click', () => set(!isOpen()));
  document.getElementById('scrim').addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) set(false);
  });
  return { open: () => set(true), close: () => set(false) };
}

// Wide screens only: the icon by "remotty" hides the list and the terminal takes
// the width. Hidden, the list floats in the middle while its finder has focus
// (style.css, :focus-within), so the finder's shortcut opens it like Spotlight
// and opening an agent puts it away. The top bar's button brings the list back.
const HIDDEN_KEY = 'remotty.sidebar-closed';
const WIDE = '(orientation: landscape) and (min-width: 701px)'; // the opposite of style.css's drawer query

export function wireSidebarToggle({ onHide }) {
  const set = (on) => {
    document.body.classList.toggle('sidebar-closed', on);
    try { localStorage.setItem(HIDDEN_KEY, on ? '1' : ''); } catch {}
  };
  try { set(localStorage.getItem(HIDDEN_KEY) === '1'); } catch {}
  document.getElementById('tabs-close').addEventListener('click', () => {
    set(true);
    onHide(); // the focus would stay in the list and float it right back
  });
  // Registered before wireDrawer: wide, this button is no drawer toggle.
  document.getElementById('menu').addEventListener('click', (e) => {
    if (!matchMedia(WIDE).matches || !document.body.classList.contains('sidebar-closed')) return;
    e.stopImmediatePropagation();
    set(false);
  });
}

// The width at which no name is cut: each row keeps its chips and padding, and
// its name gets the width of its whole text. A Range measures the text even
// where the ellipsis hides it.
function fitWidth(tabs) {
  const range = document.createRange();
  const width = (el) => el.getBoundingClientRect().width;
  const widths = [...tabs.querySelectorAll('#tab-list .name')].map((name) => {
    range.selectNodeContents(name);
    return width(tabs) - width(name) + width(range);
  });
  return Math.ceil(Math.max(0, ...widths)) + 1; // +1: subpixel text that would still ellipsize
}
