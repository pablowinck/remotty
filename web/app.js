// Entry point: pair if needed, then show the tab list and the terminal.
import { api, Unauthorized } from './features/api.js';
import { showPairing } from './features/access.js';
import { createSessions } from './features/sessions.js';
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
  const fit = () => {
    if (vv.scale > 1.01) return;
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    if (vv.offsetTop) window.scrollTo(0, 0); // iOS pans the page to the caret; undo it
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
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
  document.querySelectorAll('#app kbd').forEach((k) => (k.textContent = keyLabel(k.textContent)));
  // App shortcuts. The terminal is told which keys are ours so it never sends
  // them to the shell (see attachCustomKeyEventHandler in terminal.js).
  const shortcuts = {
    'Ctrl+Shift+K': () => sessions.focusFind(),
    'Alt+ArrowDown': () => sessions.step(1),
    'Alt+ArrowUp': () => sessions.step(-1),
    'Alt+Shift+ArrowDown': () => sessions.shift(1),
    'Alt+Shift+ArrowUp': () => sessions.shift(-1),
  };
  for (let n = 1; n <= 9; n++) shortcuts[`Alt+${n}`] = () => sessions.openIndex(n);
  const isShortcut = (e) => Boolean(shortcuts[shortcutOf(e)]);
  const terminal = createTerminal({ onStatus: setStatus, isShortcut });
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
  });
  document.addEventListener('keydown', (e) => {
    const action = shortcuts[shortcutOf(e)];
    if (action) {
      e.preventDefault();
      action();
    }
  });
  sessions.start();
}

main();
