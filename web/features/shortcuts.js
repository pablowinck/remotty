// App shortcuts, and the Settings section that rebinds them. Each device keeps
// its own (a Mac and a Windows PC want different keys), saved as overrides of
// the defaults only, so a shortcut a later version adds still arrives.
import { APPLE, shortcutOf } from './terminal.js';

const STORE = 'remotty.shortcuts';
const DIGIT = '#'; // "Alt+#": Open agent 1–9 binds the modifiers, one combo per digit

// As in Ghostty on Apple: ⌘T names a new agent, ⌘W closes it, ⌘Z reopens, ⌘E
// duplicates. Elsewhere ⌘ is the Win or Super key, which the system keeps, and
// Ctrl+Alt is AltGr on many layouts (ABNT2, German): Alt+Shift it is.
const AGENT_MOD = APPLE ? 'Meta' : 'Alt+Shift';
export const ACTIONS = [
  { id: 'find', group: 'Agents', label: 'Find or create an agent', combo: 'Ctrl+Shift+K' },
  { id: 'new', group: 'Agents', label: 'New agent', combo: `${AGENT_MOD}+${APPLE ? 'T' : 'N'}` },
  { id: 'close', group: 'Agents', label: 'Close the open agent', combo: `${AGENT_MOD}+W` },
  { id: 'reopen', group: 'Agents', label: 'Reopen the last one closed', combo: `${AGENT_MOD}+Z` },
  { id: 'duplicate', group: 'Agents', label: 'Duplicate the open agent', combo: `${AGENT_MOD}+${APPLE ? 'E' : 'D'}` },
  { id: 'open', group: 'Moving around', label: 'Open agent 1–9', combo: `Alt+${DIGIT}` },
  { id: 'next', group: 'Moving around', label: 'Next agent', combo: 'Alt+ArrowDown' },
  { id: 'prev', group: 'Moving around', label: 'Previous agent', combo: 'Alt+ArrowUp' },
  { id: 'moveDown', group: 'Moving around', label: 'Move the open agent down', combo: 'Alt+Shift+ArrowDown' },
  { id: 'moveUp', group: 'Moving around', label: 'Move the open agent up', combo: 'Alt+Shift+ArrowUp' },
];
const byId = new Map(ACTIONS.map((a) => [a.id, a]));
// Keys a browser tab keeps for itself, whatever the page asks; an installed app gets them.
const BROWSER = APPLE ? ['Meta+T', 'Meta+W', 'Meta+N', 'Meta+Q', 'Meta+L', 'Meta+R', 'Meta+Tab'] : ['Ctrl+Shift+T', 'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Ctrl+Shift+Tab'];
const installed = () => matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches;
const NAMES = {
  Ctrl: APPLE ? '⌃' : 'Ctrl', Alt: APPLE ? '⌥' : 'Alt', Shift: '⇧', Meta: APPLE ? '⌘' : /Win/.test(navigator.platform) ? 'Win' : 'Super',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', [DIGIT]: '1–9', ' ': 'Space', Escape: 'Esc',
};

let overrides = read();

function read() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE)); } catch {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter(([id, c]) => byId.has(id) && (c === null || typeof c === 'string')));
}

export const comboOf = (id) => (id in overrides ? overrides[id] : byId.get(id).combo);

// The key combos one binding answers to: nine for "Alt+#", none for null.
// The split keeps a trailing "+" key ("Alt++") whole.
const expand = (binding) => (!binding ? [] : binding.endsWith(DIGIT) ? [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => binding.slice(0, -1) + n) : [binding]);
const parts = (combo) => combo.split(/\+(?!$)/);

// The nth combo of an action (Open agent n), or undefined when it has none.
export const comboAt = (id, n = 1) => expand(comboOf(id))[n - 1];

// actionFor names the action a key event triggers; n is the digit of Open agent n.
export function actionFor(e) {
  const combo = shortcutOf(e);
  for (const a of ACTIONS) {
    const at = expand(comboOf(a.id)).indexOf(combo);
    if (at >= 0) return { id: a.id, n: at + 1 };
  }
  return null;
}

// "Ctrl+Shift+K" as the device's keyboard writes it: "Ctrl ⇧ K", or "⌃⇧K" on Apple.
export const comboKeys = (combo) => parts(combo).map((k) => NAMES[k] ?? k);
export const comboLabel = (combo) => comboKeys(combo).join(APPLE ? '' : ' ');
// In a sentence, words off Apple: "Ctrl+Shift+C", not "Ctrl ⇧ C".
const said = (combo) => (APPLE ? comboLabel(combo) : comboKeys(combo).map((k) => (k === '⇧' ? 'Shift' : k)).join('+'));

// Why a combo cannot be a shortcut ({ refuse }), or what to know if it can ({ warn }).
export function verdict(id, combo) {
  const keys = parts(combo);
  const key = keys.pop();
  const mods = keys.join('+');
  const label = said(combo);
  if (!keys.some((m) => m !== 'Shift')) return { refuse: `Add ${APPLE ? '⌥ or ⌘' : 'Alt or Ctrl+Shift'}: keys without them are typed into the terminal` };
  if (combo === 'Ctrl+C') return { refuse: `${label} is the terminal's interrupt. Try ${said('Alt+Shift+C')}` };
  if (mods === 'Ctrl') return { refuse: `${label} sends a control key to the terminal. Add ⇧ or Alt` };
  if (mods === 'Alt' && /^[A-Z.]$/.test(key)) return { refuse: `${label} moves by word in the shell; add ⇧` };
  if (key === 'Enter' && !keys.includes('Ctrl') && !keys.includes('Meta')) return { refuse: `${label} is a new line in the prompt` };
  if ((APPLE ? mods === 'Meta' : mods === 'Ctrl+Shift') && 'CVAX'.includes(key)) return { refuse: `${label} is for copy and paste` };
  if (id === 'open' && !/^\d$/.test(key)) return { refuse: `Hold the modifiers with a digit, like ${said('Alt+1')}` };
  if (!APPLE && keys.includes('Meta')) return { warn: `The system keeps most ${NAMES.Meta} shortcuts for itself` };
  if (!APPLE && mods === 'Alt' && /^Arrow(Left|Right)$/.test(key)) return { warn: 'The browser may take it as Back or Forward' };
  if (!APPLE && keys.includes('Ctrl') && keys.includes('Alt')) return { warn: 'Ctrl+Alt is AltGr on many layouts, where it types a character instead' };
  if (BROWSER.includes(combo) && !installed()) return { warn: 'A browser tab keeps this one; it works once remotty is installed as an app' };
  return {};
}

// bind gives id the combo (null: none), taking it from any action that had it.
// Returns the bindings before the change, for Undo, and the actions it took from.
function bind(id, combo) {
  const before = { ...overrides };
  const taken = ACTIONS.filter((a) => a.id !== id && expand(comboOf(a.id)).some((c) => expand(combo).includes(c)));
  for (const a of taken) put(a.id, null);
  put(id, combo);
  save();
  return { before, taken };
}

function put(id, combo) {
  if (combo === byId.get(id).combo) delete overrides[id];
  else overrides[id] = combo;
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(overrides)); } catch {}
}

// Shown for discovery only: what the terminal itself does with these keys.
const FIXED = [
  { label: 'New line in the prompt', combo: 'Shift+Enter' },
  { label: 'Paste', combo: APPLE ? 'Meta+V' : 'Ctrl+V' },
  { label: 'Open a link', combo: `${APPLE ? 'Meta' : 'Ctrl'}+Click` },
];
const IGNORED = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', 'Process'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const caps = (combo) => comboKeys(combo).map((k) => el('kbd', '', k));

// The Shortcuts section: a row per action. Click its keys, press the new ones.
// While one waits for keys, every key press on the page is its: Safari never
// focuses a clicked button, so listening on the list alone would miss them.
export function wireShortcutsPane(root, live, onChange, resetButton, legend) {
  let recording = null; // the action whose new keys are awaited
  let note = null; // { id, text, tone, undo }: said under that row until the next change

  function render() {
    resetButton.parentElement.querySelector('.sc-msg')?.remove();
    const groups = [...new Set(ACTIONS.map((a) => a.group))];
    root.replaceChildren(
      ...groups.map((g) => group(g, ACTIONS.filter((a) => a.group === g).map(row))),
      group('Terminal (fixed)', FIXED.map(fixedRow)),
    );
    const changed = Object.keys(overrides).length;
    resetButton.disabled = !changed;
    legend.textContent = changed ? `${changed} changed from the default` : 'Every shortcut is at its default';
    legend.classList.toggle('some', Boolean(changed));
    legend.hidden = false;
  }

  // Cleared first: the same words twice in a row are otherwise not read again.
  function announce(text) {
    live.textContent = '';
    requestAnimationFrame(() => (live.textContent = text));
  }

  function group(title, rows) {
    const section = el('section', 'sc-group');
    const list = el('ul', 'settings-list');
    list.append(...rows);
    section.append(el('h4', '', title), list);
    return section;
  }

  function row(a) {
    const li = el('li', 'sc-row');
    li.dataset.id = a.id;
    const changed = a.id in overrides;
    li.classList.toggle('changed', changed);
    const label = el('span', 'sc-label', a.label);
    if (changed) label.append(el('span', 'visually-hidden', ' (changed)'));
    const combo = comboOf(a.id);
    if (combo && BROWSER.includes(combo) && !installed()) label.append(el('small', 'sc-sub', 'Works in the installed app; a browser tab keeps it'));
    const keys = el('button', 'sc-keys');
    keys.type = 'button';
    keys.dataset.id = a.id;
    fill(keys, a);
    li.append(label);
    if (changed) {
      const reset = el('button', 'sc-reset');
      reset.type = 'button';
      reset.dataset.reset = a.id;
      reset.title = `Reset to ${comboLabel(a.combo)}`;
      reset.setAttribute('aria-label', `Reset ${a.label} to default`);
      li.append(reset);
    }
    li.append(keys);
    if (note?.id === a.id) li.append(noteElement(note));
    return li;
  }

  function noteElement({ text, tone, undo }) {
    const p = el('p', `sc-msg ${tone}`, text);
    if (tone === 'error') p.setAttribute('role', 'alert');
    if (undo) {
      const button = el('button', 'sc-undo', 'Undo');
      button.type = 'button';
      button.addEventListener('click', () => {
        overrides = undo;
        save();
        note = null;
        render();
        announce('Undone');
        onChange();
      });
      p.append(' ', button);
    }
    return p;
  }

  function fixedRow({ label, combo }) {
    const li = el('li', 'sc-row fixed');
    const keys = el('span', 'sc-keys');
    keys.append(...caps(combo));
    li.append(el('span', 'sc-label', label), keys);
    return li;
  }

  function fill(button, a) {
    const combo = comboOf(a.id);
    const waiting = recording === a.id;
    button.classList.toggle('recording', waiting);
    button.setAttribute('aria-pressed', String(waiting));
    button.replaceChildren(...(waiting ? [el('span', 'sc-wait', 'Press keys…')] : combo ? caps(combo) : [el('span', 'sc-none', 'None')]));
    // The how-to sits by the row being recorded; the hint at the top may be scrolled away.
    const help = button.closest('.sc-row')?.querySelector('.sc-help');
    if (waiting && !help) button.closest('.sc-row').querySelector('.sc-label').append(el('small', 'sc-sub sc-help', 'Esc cancels · Backspace clears'));
    if (!waiting) help?.remove();
    button.setAttribute('aria-label', `${a.label}: ${waiting ? 'press the new keys, Esc to cancel' : combo ? comboLabel(combo) : 'no shortcut'}`);
  }

  const keysOf = (id) => root.querySelector(`.sc-keys[data-id="${id}"]`);
  const rowOf = (id) => root.querySelector(`.sc-row[data-id="${id}"]`);

  function clearNote() {
    note = null;
    root.querySelector('.sc-msg')?.remove();
  }

  function record(id) {
    const was = recording;
    recording = id;
    clearNote();
    if (was) fill(keysOf(was), byId.get(was));
    fill(keysOf(id), byId.get(id));
    keysOf(id).focus();
    announce(`Press the new keys for ${byId.get(id).label}. Esc cancels.`);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
  }

  function stop() {
    const was = recording;
    recording = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    if (!was) return;
    if (note?.tone === 'error') clearNote();
    fill(keysOf(was), byId.get(was));
  }

  // A refusal shows under the row, the keys stay unchanged, and it keeps waiting.
  function say(id, text) {
    note = { id, text, tone: 'error' };
    rowOf(id).querySelector('.sc-msg')?.remove();
    const p = noteElement(note);
    rowOf(id).append(p);
    p.scrollIntoView({ block: 'nearest' });
  }

  function commit(id, combo, warn) {
    stop();
    const { before, taken } = bind(id, combo);
    const a = byId.get(id);
    const lost = taken.length && `${combo ? said(combo.replace(DIGIT, '1–9')) : ''} moved here from ${taken.map((t) => t.label).join(', ')}, which now ${taken.length > 1 ? 'have' : 'has'} none`;
    const text = [lost, warn].filter(Boolean).join('. ');
    note = text ? { id, text, tone: 'warn', undo: lost ? before : null } : null;
    render();
    keysOf(id).focus();
    keysOf(id).classList.add('just-set');
    for (const t of taken) keysOf(t.id).classList.add('just-lost');
    for (const t of taken) keysOf(t.id).scrollIntoView({ block: 'nearest' }); // the row that lost its keys, then the one that got them
    rowOf(id).scrollIntoView({ block: 'nearest' });
    announce(`${a.label}: ${combo ? comboLabel(combo) : 'no shortcut'}. ${text}`);
    onChange();
  }

  function onKey(e) {
    if (!recording) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return stop(); // leaving: let focus move on
    e.preventDefault(); // Esc must not close the dialog, nor any key reach the app
    e.stopPropagation();
    const combo = shortcutOf(e);
    if (IGNORED.includes(parts(combo).at(-1)) || e.repeat) return;
    const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (e.key === 'Escape' && bare) return stop();
    if ((e.key === 'Backspace' || e.key === 'Delete') && bare) return commit(recording, null);
    const { refuse, warn } = verdict(recording, combo);
    if (refuse) return say(recording, refuse);
    commit(recording, recording === 'open' ? combo.replace(/\d$/, DIGIT) : combo, warn);
  }

  // A press anywhere but the waiting row ends the wait (and still does its job).
  function onPointer(e) {
    if (!e.target.closest(`.sc-row[data-id="${recording}"]`)) stop();
  }

  // The whole row is the target, not only its keys; its ↺ and Undo are their own.
  root.addEventListener('click', (e) => {
    const reset = e.target.closest('.sc-reset');
    if (reset) return commit(reset.dataset.reset, byId.get(reset.dataset.reset).combo);
    if (e.target.closest('.sc-msg')) return; // reading or undoing a note is no request to record
    const id = e.target.closest('.sc-row:not(.fixed)')?.dataset.id;
    if (id) recording === id ? stop() : record(id);
  });
  resetButton.addEventListener('click', resetAll);

  function resetAll() {
    stop();
    const before = { ...overrides };
    overrides = {};
    save();
    note = null;
    render();
    const p = noteElement({ text: 'Every shortcut is back to its default.', tone: 'warn', undo: before });
    resetButton.parentElement.prepend(p); // by the button pressed, not at the end of a list scrolled away
    legend.hidden = true; // the note says it; "at its default" under it would say it twice
    p.querySelector('.sc-undo').addEventListener('click', () => p.remove());
    announce('Every shortcut is back to its default');
    onChange();
  }
  root.addEventListener('animationend', (e) => e.target.classList.remove('just-set', 'just-lost'));

  return {
    open() {
      stop();
      note = null;
      render();
    },
    close: stop,
  };
}
