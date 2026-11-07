// Settings: which keys the bar under the terminal shows, and in what order;
// and the theme.
// It is this device's own business, like the sidebar width: a phone wants every
// key, a PC with a real keyboard wants none. The microphone and attach are not
// listed: they are always there, at the end of the bar.
const KEYS_KEY = 'remotty.keys';
const THEME_KEY = 'remotty.theme';
const THEMES = ['graphite', 'ghostty'];

// The theme this device picked; graphite until it picks another.
export function savedTheme() {
  let name = null;
  try { name = localStorage.getItem(THEME_KEY); } catch {}
  return THEMES.includes(name) ? name : 'graphite';
}

const idOf = (b) => b.dataset.key || b.dataset.mod || b.dataset.action;
// What each key does, in words, next to its cap.
const MEANING = {
  esc: 'Escape', tab: 'Tab, completes', ctrl: 'Ctrl for the next key', up: 'Arrow up, history', down: 'Arrow down',
  enter: 'Enter', 'ctrl-c': 'Interrupt (Ctrl+C)', left: 'Arrow left', right: 'Arrow right', paste: 'Paste the clipboard',
};

export function wireSettings({ onClose = () => {}, onTheme = () => {} } = {}) {
  const bar = document.getElementById('keys');
  const fixed = bar.querySelector('[data-action="attach"]'); // configurable keys go before it
  const buttons = new Map([...bar.querySelectorAll('button')].filter((b) => b.dataset.action !== 'attach' && b.dataset.action !== 'record').map((b) => [idOf(b), b]));
  // No saved choice: a touch screen gets every key, a mouse and keyboard none.
  const defaults = () => [...buttons.keys()].map((id) => ({ id, shown: matchMedia('(pointer: coarse)').matches }));
  let keys = load(buttons, defaults);

  const dialog = document.getElementById('settings');
  const list = document.getElementById('key-settings');

  function apply() {
    for (const { id, shown } of keys) {
      bar.insertBefore(buttons.get(id), fixed);
      buttons.get(id).hidden = !shown;
    }
    bar.classList.toggle('only-fixed', !keys.some((k) => k.shown));
  }

  function save() {
    try { localStorage.setItem(KEYS_KEY, JSON.stringify(keys)); } catch {}
    apply();
  }

  function render() {
    list.replaceChildren(...keys.map((k) => row(k, buttons.get(k.id))));
  }

  function row(k, button) {
    const li = document.createElement('li');
    li.dataset.id = k.id;
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⠿';
    grip.setAttribute('aria-hidden', 'true');
    const label = document.createElement('label');
    label.className = 'label';
    const cap = document.createElement('kbd');
    cap.textContent = button.textContent;
    label.append(cap, MEANING[k.id] || button.getAttribute('aria-label') || button.textContent);
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggle.checked = k.shown;
    label.htmlFor = toggle.id = `key-${k.id}`;
    toggle.addEventListener('change', () => {
      k.shown = toggle.checked;
      save();
    });
    li.append(grip, label, toggle);
    return li;
  }

  // Alt+Up / Alt+Down on a row moves it, for whoever reorders without a pointer.
  list.addEventListener('keydown', (e) => {
    const dir = e.altKey && !e.shiftKey && { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation(); // Alt+arrows also switch agents; not while reordering here
    const id = e.target.closest('li')?.dataset.id;
    const at = keys.findIndex((k) => k.id === id);
    if (at < 0 || !keys[at + dir]) return;
    [keys[at], keys[at + dir]] = [keys[at + dir], keys[at]];
    save();
    render();
    document.getElementById(`key-${id}`).focus();
  });

  wireGripDrag(list, () => {
    const order = [...list.children].map((li) => li.dataset.id);
    keys.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    save();
  });

  document.getElementById('keys-reset').addEventListener('click', () => {
    try { localStorage.removeItem(KEYS_KEY); } catch {}
    keys = defaults();
    apply();
    render();
  });
  document.getElementById('settings-done').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close()); // a tap on the backdrop
  dialog.addEventListener('close', onClose);

  const picker = document.getElementById('theme-picker');
  picker.addEventListener('change', (e) => {
    try { localStorage.setItem(THEME_KEY, e.target.value); } catch {}
    onTheme(e.target.value);
  });

  apply();
  return {
    open() {
      render();
      picker.querySelector(`[value="${savedTheme()}"]`).checked = true;
      dialog.showModal();
    },
  };
}

// Saved order and choices, with keys this version added appended (shown as by
// default) and keys it no longer has dropped.
function load(buttons, defaults) {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(KEYS_KEY)) || []; } catch {}
  if (!Array.isArray(saved) || !saved.length) return defaults();
  const known = saved.filter((k) => buttons.has(k?.id)).map((k) => ({ id: k.id, shown: Boolean(k.shown) }));
  return [...known, ...defaults().filter((d) => !known.some((k) => k.id === d.id))];
}

// Drag a row by its grip: the row follows the pointer through the list, and
// the order is kept when it is let go. Mouse and finger alike; the grip takes
// no scroll (touch-action: none), so a finger drag needs no hold first. The
// list holds the pointer, not the grip: moving the row in the DOM would drop it.
function wireGripDrag(list, onDrop) {
  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip) return;
    e.preventDefault();
    const li = grip.closest('li');
    list.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
    const move = (m) => {
      const over = [...list.children].find((r) => r !== li && m.clientY > r.getBoundingClientRect().top && m.clientY < r.getBoundingClientRect().bottom);
      if (!over) return;
      const below = m.clientY > over.getBoundingClientRect().top + over.getBoundingClientRect().height / 2;
      list.insertBefore(li, below ? over.nextSibling : over);
    };
    list.addEventListener('pointermove', move);
    list.addEventListener('lostpointercapture', () => {
      list.removeEventListener('pointermove', move);
      li.classList.remove('dragging');
      onDrop();
    }, { once: true });
  });
}
