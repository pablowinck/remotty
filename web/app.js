// Entry point: pair if needed, then show the tab list and the terminal.
import { api, Unauthorized } from './features/api.js';
import { showPairing } from './features/access.js';
import { createSessions } from './features/sessions.js';
import { wireDrawer, wireSidebar, wireSidebarToggle } from './features/sidebar.js';
import { savedTheme, wireSettings } from './features/settings.js';
import { actionFor, comboLabel, comboOf } from './features/shortcuts.js';
import { createTerminal } from './features/terminal.js';

const status = document.getElementById('status');
const setStatus = (text) => (status.textContent = text);

// iOS Safari ignores interactive-widget=resizes-content: the soft keyboard
// covers the page instead of shrinking it, hiding the prompt and the key bar.
// Only the visual viewport shrinks, so the app is sized to it. Elsewhere its
// height equals 100dvh. A pinch zoom also shrinks it; that is not a keyboard.
function followVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  // Only while something covers the page (the keyboard): otherwise 100dvh is
  // already right, and following every event resized the terminal twice on a
  // plain window resize, once at a height the viewport only passed through.
  const fit = () => {
    if (vv.scale > 1.01) return;
    if (vv.height < innerHeight - 1) root.setProperty('--app-h', `${vv.height}px`);
    else root.removeProperty('--app-h');
    if (vv.offsetTop) window.scrollTo(0, 0); // iOS pans the page to the caret; undo it
  };
  let queued = 0; // one fit per frame: the events come in bursts while the keyboard slides
  const later = () => queued || (queued = requestAnimationFrame(() => { queued = 0; fit(); }));
  vv.addEventListener('resize', later);
  vv.addEventListener('scroll', later);
  fit();
}

async function main() {
  try {
    await api('GET', '/api/me');
  } catch (e) {
    if (e instanceof Unauthorized) return showPairing(main);
    setStatus(`Host unreachable: ${e.message}`);
    return;
  }
  document.getElementById('app').hidden = false;
  followVisualViewport();
  wireSidebar();
  wireSidebarToggle({ onHide: () => terminal.focus() });
  const drawer = wireDrawer();
  // App shortcuts (rebindable in Settings, see shortcuts.js). The terminal is
  // told which keys are ours so it never sends them to the shell (see
  // attachCustomKeyEventHandler in terminal.js).
  const run = {
    find: () => findAgent(),
    new: () => {
      drawer.open(); // on a narrow screen the finder lives in the drawer
      sessions.newAgent();
    },
    close: () => sessions.closeCurrent(),
    reopen: () => sessions.reopenLast(),
    duplicate: () => sessions.duplicateCurrent(),
    open: (n) => sessions.openIndex(n),
    next: () => sessions.step(1),
    prev: () => sessions.step(-1),
    moveDown: () => sessions.shift(1),
    moveUp: () => sessions.shift(-1),
  };
  const isShortcut = (e) => Boolean(actionFor(e));
  const MOVES = ['next', 'prev', 'moveDown', 'moveUp']; // these may repeat while held
  showFindKey();
  const theme = savedTheme();
  await showTheme(theme); // before xterm opens: it measures its cell once, on the font it has then
  await styled(document.querySelector('link[href="/lib/xterm/xterm.css"]'));
  const terminal = createTerminal({ onStatus: setStatus, isShortcut, look: theme });
  const sessions = createSessions({
    onSelect: (id) => {
      document.getElementById('empty').hidden = Boolean(id);
      terminal.connect(id);
    },
    onError: (e) => {
      if (e instanceof Unauthorized) location.reload(); // revoked: back to pairing
      else setStatus(e.message);
    },
    onStatus: setStatus,
    focusTerminal: () => terminal.focus(),
    holdKeys: () => terminal.hold(),
    onOpen: () => drawer.close(),
    // The host answers again: drop the poll's error, and the terminal need not wait out its backoff.
    onReachable: () => {
      setStatus('');
      terminal.retry();
    },
  });
  // On a narrow screen the finder lives in the drawer: open it first.
  const findAgent = () => {
    drawer.open();
    sessions.focusFind();
  };
  document.getElementById('top-new').addEventListener('click', findAgent);
  const settings = wireSettings({
    onClose: () => terminal.focus(),
    onTheme: async (name) => {
      await showTheme(name);
      terminal.setLook(name);
    },
    onShortcuts: () => {
      showFindKey();
      sessions.redraw(); // the Alt+N chips on the rows
    },
  });
  document.getElementById('open-settings').addEventListener('click', () => {
    drawer.close();
    settings.open();
  });
  document.addEventListener('keydown', (e) => {
    const action = actionFor(e);
    if (!action || document.querySelector('dialog[open]')) return; // a dialog is up: its keys are its own
    if (e.repeat && !MOVES.includes(action.id)) return e.preventDefault(); // a held ⌘W closes one agent, not ten
    if (e.target.id === 'find' && action.id === 'reopen') return; // typing a name: ⌘Z undoes text
    e.preventDefault();
    run[action.id](action.n);
  });
  sessions.start();
}

// A stylesheet whose request dropped (a tablet on a flaky link did) leaves xterm
// unstyled: its measuring glyphs show on top and its rows run under the keys.
// One more try before the terminal opens.
async function styled(link) {
  if (loaded(link.sheet)) return;
  const again = link.cloneNode();
  await new Promise((done) => {
    again.onload = again.onerror = done;
    link.replaceWith(again);
  });
}

// A failed load still has a sheet, whose rules throw instead.
function loaded(sheet) {
  try {
    return sheet.cssRules.length > 0;
  } catch {
    return false;
  }
}

// The finder's chip and its aria-keyshortcuts follow the Find binding.
function showFindKey() {
  const combo = comboOf('find');
  document.getElementById('find-key').textContent = combo ? comboLabel(combo) : '';
  document.getElementById('find-key').hidden = !combo;
  const find = document.getElementById('find');
  if (combo) find.setAttribute('aria-keyshortcuts', combo.replace('Ctrl', 'Control'));
  else find.removeAttribute('aria-keyshortcuts');
}

// The page's colours follow the theme (style.css). Ghostty's embedded font is
// loaded first: measured on the fallback, the PTY was resized again moments later.
async function showTheme(name) {
  document.documentElement.dataset.theme = name;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (name === 'ghostty') await document.fonts?.load('13px "JetBrains Mono"').catch(() => {});
}

main();
