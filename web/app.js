// Entry point: pair if needed, then show the tab list and the terminal.
import { api, Unauthorized } from './features/api.js';
import { showPairing } from './features/access.js';
import { createSessions } from './features/sessions.js';
import { wireDrawer, wireSidebar } from './features/sidebar.js';
import { savedTheme, wireSettings } from './features/settings.js';
import { createTerminal, keyLabel, shortcutOf } from './features/terminal.js';

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
  const drawer = wireDrawer();
  document.querySelectorAll('#app kbd').forEach((k) => (k.textContent = keyLabel(k.textContent)));
  // App shortcuts. The terminal is told which keys are ours so it never sends
  // them to the shell (see attachCustomKeyEventHandler in terminal.js).
  const shortcuts = {
    'Ctrl+Shift+K': () => findAgent(),
    // As in Ghostty: ⌘T names a new agent (Enter creates it), ⌘W closes the open
    // one, ⌘Z reopens the last one closed, ⌘E duplicates the open one.
    'Meta+T': () => {
      drawer.open(); // on a narrow screen the finder lives in the drawer
      sessions.newAgent();
    },
    'Meta+W': () => sessions.closeCurrent(),
    'Meta+Z': () => sessions.reopenLast(),
    'Meta+E': () => sessions.duplicateCurrent(),
    'Alt+ArrowDown': () => sessions.step(1),
    'Alt+ArrowUp': () => sessions.step(-1),
    'Alt+Shift+ArrowDown': () => sessions.shift(1),
    'Alt+Shift+ArrowUp': () => sessions.shift(-1),
  };
  for (let n = 1; n <= 9; n++) shortcuts[`Alt+${n}`] = () => sessions.openIndex(n);
  const isShortcut = (e) => Boolean(shortcuts[shortcutOf(e)]);
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
  });
  document.getElementById('open-settings').addEventListener('click', () => {
    drawer.close();
    settings.open();
  });
  document.addEventListener('keydown', (e) => {
    const action = shortcuts[shortcutOf(e)];
    if (e.target.id === 'find' && shortcutOf(e) === 'Meta+Z') return; // typing a name: ⌘Z undoes text
    if (action) {
      e.preventDefault();
      action();
    }
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

// The page's colours follow the theme (style.css). Ghostty's embedded font is
// loaded first: measured on the fallback, the PTY was resized again moments later.
async function showTheme(name) {
  document.documentElement.dataset.theme = name;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (name === 'ghostty') await document.fonts?.load('13px "JetBrains Mono"').catch(() => {});
}

main();
