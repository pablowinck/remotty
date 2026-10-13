// Tab list: one entry per tmux window, polled so bells and idle agents show up
// without the tab being open. Folders group agents; a folder lives in tmux like
// the windows, while whether it is collapsed is this browser's own business.
// The field on top filters the list and creates agents, so the whole flow works
// from the keyboard:
//   Ctrl+Shift+K, type, Enter  -> open the highlighted agent, or create one
import { api } from './api.js';
import { keyLabel } from './terminal.js';

const POLL_MS = 2000;
const COLLAPSED_KEY = 'remotty.collapsed';

// Storage can be missing or throw (private mode, blocked site data): folders then
// just start open on every load.
function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {}
}

const stateOf = (w) => (w.bell ? 'bell' : w.silence ? 'waiting' : w.activity ? 'activity' : 'idle');

export function createSessions({ onSelect, onError, onStatus = () => {}, focusTerminal, holdKeys = () => {} }) {
  const list = document.getElementById('tab-list');
  const find = document.getElementById('find');
  const menu = document.getElementById('tab-menu');
  let windows = [];
  let folders = [];
  const collapsed = loadCollapsed();
  let current = null;
  let highlighted = 0; // index into the visible rows while the field has focus
  let timer = null;

  async function refresh() {
    try {
      [windows, folders] = await Promise.all([api('GET', '/api/windows'), api('GET', '/api/folders')]);
    } catch (e) {
      onError(e);
      return;
    }
    render();
    // The open window was closed elsewhere (ssh, an agent exiting): follow tmux
    // to a window that still exists instead of retrying a dead one forever.
    if (current && !windows.some((w) => w.id === current)) {
      const next = windows.find((w) => w.active) || windows[0];
      select(next ? next.id : null);
    }
  }

  const query = () => find.value.trim();
  // A window tagged with a folder this server no longer lists counts as loose.
  const folderOf = (w) => (folders.includes(w.folder) ? w.folder : '');
  const inFolder = (f) => windows.filter((w) => folderOf(w) === f);

  // Display order: each folder with its windows, in creation order, then the loose ones.
  const ordered = () => [...folders.flatMap(inFolder), ...inFolder('')];

  // A number matches the window index exactly; anything else matches the name.
  function visible() {
    const q = query().toLowerCase();
    if (!q) return ordered();
    if (/^\d+$/.test(q)) return windows.filter((w) => String(w.index) === q);
    return ordered().filter((w) => w.name.toLowerCase().includes(q));
  }

  // Rows the keyboard can land on: the matches, then "create" when there is a name.
  function rows() {
    const matches = visible();
    const name = query();
    if (!name || /^\d+$/.test(name)) return matches;
    const creates = matches.some((w) => w.name === name) ? [] : [{ create: name }];
    if (!folders.includes(name)) creates.push({ createFolder: name });
    return [...matches, ...creates];
  }

  // The list with nothing typed: folder headers, their windows unless collapsed
  // (the open one always shows, so you can see where you are), then the rest.
  function tree() {
    const shown = (f) => inFolder(f).filter((w) => !collapsed.has(f) || w.id === current);
    return [...folders.flatMap((f) => [{ header: f }, ...shown(f)]), ...inFolder('')];
  }

  function render() {
    const all = query() ? rows() : tree();
    highlighted = Math.min(highlighted, Math.max(all.length - 1, 0));
    const searching = document.activeElement === find && query() !== '';
    list.replaceChildren(...all.map((row, i) => {
      const li = rowElement(row);
      li.classList.toggle('highlighted', searching && i === highlighted);
      return li;
    }));
    list.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
  }

  function rowElement(row) {
    if (row.create !== undefined) return createRow('create', `+ New agent "${row.create}"`, () => create(row.create));
    if (row.createFolder !== undefined) return createRow('create-folder', `+ New folder "${row.createFolder}"`, () => addFolder(row.createFolder));
    if (row.header !== undefined) return folderRow(row.header);
    return item(row);
  }

  function createRow(className, label, run) {
    const li = document.createElement('li');
    li.className = className;
    li.textContent = label;
    li.addEventListener('click', run);
    return li;
  }

  // A collapsed folder still lights up when an agent inside it rings or waits.
  function folderRow(f) {
    const inside = inFolder(f);
    const li = document.createElement('li');
    li.className = 'folder';
    li.dataset.folder = f;
    li.setAttribute('aria-expanded', String(!collapsed.has(f)));
    li.dataset.state = ['bell', 'waiting', 'activity'].find((s) => inside.some((w) => stateOf(w) === s)) || 'idle';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f; // textContent: any client may name a folder
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = inside.length;
    li.append(name, dot, count);
    li.addEventListener('click', () => toggleFolder(f));
    return li;
  }

  function toggleFolder(f) {
    if (!collapsed.delete(f)) collapsed.add(f);
    saveCollapsed(collapsed);
    render();
  }

  async function addFolder(name) {
    try {
      await api('POST', '/api/folders', { name });
      find.value = '';
      await refresh();
    } catch (e) {
      onError(e);
    }
  }

  function item(w) {
    const li = document.createElement('li');
    li.dataset.id = w.id;
    li.dataset.state = stateOf(w);
    li.dataset.folder = folderOf(w);
    li.classList.toggle('in-folder', !query() && folderOf(w) !== '');
    li.setAttribute('aria-current', String(w.id === current));
    li.title = 'Double-tap to rename';

    const index = document.createElement('span');
    index.className = 'index';
    index.textContent = w.index;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = w.name; // textContent: window names are set by programs inside the terminal
    li.dataset.index = w.index;
    const hotkey = document.createElement('kbd');
    hotkey.className = 'hotkey';
    if (w.index >= 1 && w.index <= 9) hotkey.textContent = keyLabel(`Alt ${w.index}`);
    const more = document.createElement('button');
    more.className = 'more';
    more.type = 'button';
    more.textContent = '⋯';
    more.setAttribute('aria-label', `Options for ${w.name}`);
    more.setAttribute('aria-haspopup', 'menu');

    li.append(index, dot, name, ...(hotkey.textContent ? [hotkey] : []), more);
    li.addEventListener('click', (e) => {
      if (dragged) return; // the pointerup that ends a drag is not a tap
      if (e.target === more) showMenu(w, more.getBoundingClientRect());
      else open(w.id);
    });
    li.addEventListener('dblclick', () => rename(w));
    return li;
  }

  // Drag to reorder. Pointer events cover mouse and finger alike. A mouse drag
  // starts after a few pixels of travel, so a click still opens. A finger has to
  // hold still first (HOLD_MS): otherwise every swipe that scrolls the tab strip
  // or the list would drag a tab. The order lives in tmux (window indexes), so a
  // drop moves the window on the host and every client sees the new order.
  let drag = null;
  let dragged = false;
  const DRAG_PX = 8;
  const HOLD_MS = 350;
  const horizontal = () => getComputedStyle(list).display === 'flex';

  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li || e.button !== 0 || e.target.closest('.more') || query()) return;
    drag = { li, x: e.clientX, y: e.clientY, on: false, pointerId: e.pointerId };
    dragged = false;
    if (e.pointerType === 'touch') drag.hold = setTimeout(() => startDrag(), HOLD_MS);
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const travel = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.on) {
      if (e.pointerType === 'touch') {
        if (travel > DRAG_PX) cancelDrag(); // moved before the hold: it is a scroll
        return;
      }
      if (travel < DRAG_PX) return;
      startDrag();
    }
    e.preventDefault();
    markDrop(e);
  });
  // While a finger drag is on, the browser must not scroll the list instead.
  list.addEventListener('touchmove', (e) => drag?.on && e.preventDefault(), { passive: false });

  function startDrag() {
    drag.on = true;
    dragged = true;
    drag.li.setPointerCapture?.(drag.pointerId);
    drag.li.classList.add('dragging');
    clearInterval(timer); // a poll would redraw the list under the pointer
  }

  function cancelDrag() {
    clearTimeout(drag?.hold);
    drag = null;
  }

  list.addEventListener('pointerup', finishDrag);
  list.addEventListener('pointercancel', () => finishDrag(null));
  list.addEventListener('dragstart', (e) => e.preventDefault()); // no native ghost image

  // The row under the pointer, and whether the drop lands after its middle.
  // A folder header takes the drop as a whole: the window goes into it.
  function dropSpot(e, dragging = drag.li) {
    const over = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches?.('li[data-id], li.folder') && el !== dragging);
    if (!over) return null;
    if (over.classList.contains('folder')) return { over, into: true };
    const r = over.getBoundingClientRect();
    const after = horizontal() ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    return { over, after };
  }

  function markDrop(e) {
    list.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
    const spot = dropSpot(e);
    spot?.over.classList.add(spot.into ? 'drop-into' : spot.after ? 'drop-after' : 'drop-before');
  }

  async function finishDrag(e) {
    const d = drag;
    cancelDrag();
    if (!d?.on) return;
    const spot = e && dropSpot(e, d.li);
    d.li.classList.remove('dragging');
    timer = setInterval(refresh, POLL_MS);
    if (spot) await drop(d.li, spot);
    else render();
    setTimeout(() => (dragged = false)); // after the click this pointerup produces
  }

  // Dropped next to a window, the dragged one also joins that window's folder,
  // so dragging beside a loose tab is how a window leaves its folder.
  async function drop(li, spot) {
    const folder = spot.over.dataset.folder;
    if (!spot.into) await move(li.dataset.id, spot.over.dataset.id, spot.after, false);
    if (folder !== li.dataset.folder) await setFolder(li.dataset.id, folder);
    await refresh();
  }

  async function move(id, target, after, reload = true) {
    try {
      await api('POST', `/api/windows/${encodeURIComponent(id)}/move`, { target, after });
    } catch (e) {
      onError(e);
    }
    if (reload) await refresh();
  }

  // The ⋯ menu of one agent. A popover, so a tap outside or Esc closes it; it is
  // placed from the button's rect because the poll may redraw the button away.
  function showMenu(w, anchor) {
    const moveTo = menuItem('Move to…', () => showFolders(w, anchor), true);
    moveTo.disabled = !folders.length; // nowhere to move to yet
    menu.replaceChildren(moveTo, menuItem('Close', () => remove(w)));
    menu.showPopover();
    placeMenu(anchor);
    menu.querySelector('button:not(:disabled)').focus();
  }

  function showFolders(w, anchor) {
    const here = folderOf(w);
    const targets = folders.filter((f) => f !== here).map((f) => menuItem(f, () => moveToFolder(w, f)));
    if (here) targets.push(menuItem('No folder', () => moveToFolder(w, '')));
    menu.replaceChildren(...targets);
    placeMenu(anchor);
    menu.querySelector('button').focus();
  }

  function menuItem(label, run, keepOpen = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label; // textContent: folder names come from any client
    b.addEventListener('click', () => {
      if (!keepOpen) menu.hidePopover();
      run();
    });
    return b;
  }

  // Right edge on the button, below it, or above when it would leave the screen.
  function placeMenu(anchor) {
    const m = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(anchor.right - m.width, innerWidth - m.width - 4))}px`;
    menu.style.top = `${anchor.bottom + m.height > innerHeight ? Math.max(4, anchor.top - m.height) : anchor.bottom}px`;
  }

  async function moveToFolder(w, folder) {
    await setFolder(w.id, folder);
    refresh();
  }

  async function setFolder(id, folder) {
    collapsed.delete(folder); // you just put it there: show it
    saveCollapsed(collapsed);
    await api('PUT', `/api/windows/${encodeURIComponent(id)}/folder`, { name: folder }).catch(onError);
  }

  function select(id) {
    current = id;
    render();
    onSelect(id);
  }

  // open: leave the list and hand the keyboard to that agent's terminal.
  function open(id) {
    find.value = '';
    highlighted = 0;
    select(id);
    focusTerminal();
    revealCurrent();
  }

  // On a phone the tabs are a strip wider than the screen: bring the chosen one
  // in. Only once the finder has closed, because the strip is hidden while it is open.
  function revealCurrent() {
    list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Keys typed while the host makes the window go to it, not to the agent on
  // screen. If it fails, they go where they went before: the current window.
  async function create(name) {
    holdKeys();
    try {
      const { id } = await api('POST', '/api/windows', { name });
      await refresh();
      open(id);
    } catch (e) {
      select(current);
      onError(e);
    }
  }

  async function rename(w) {
    const name = prompt('Rename window:', w.name);
    if (!name || name === w.name) return;
    await api('PATCH', `/api/windows/${encodeURIComponent(w.id)}`, { name }).catch(onError);
    refresh();
  }

  async function remove(w) {
    if (!confirm(`Close "${w.name}"? Whatever runs in it will be killed.`)) return;
    await api('DELETE', `/api/windows/${encodeURIComponent(w.id)}`).catch(onError);
    if (w.id === current) {
      current = null;
      onSelect(null);
    }
    refresh();
  }

  function onFindKey(e) {
    const all = rows();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      highlighted = (highlighted + step + all.length) % Math.max(all.length, 1);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = all[highlighted];
      if (row?.create !== undefined) create(row.create);
      else if (row?.createFolder !== undefined) addFolder(row.createFolder);
      else if (row) open(row.id);
      else if (!query()) create(''); // empty field + Enter: a fresh agent
    } else if (e.key === 'Escape') {
      e.preventDefault();
      find.value = '';
      render();
      focusTerminal();
    }
  }

  find.addEventListener('input', () => {
    highlighted = 0;
    render();
  });
  find.addEventListener('keydown', onFindKey);
  // A tap on a result would first blur the finder, which hides the results on a
  // phone before the click lands. Keeping focus on pointerdown lets the tap through.
  list.addEventListener('pointerdown', (e) => {
    if (document.activeElement === find) e.preventDefault();
  });
  find.addEventListener('blur', () => setTimeout(render)); // drop the highlight
  // Tapping "+" must not blur the finder on the way (the tap lands on the button,
  // which would steal focus), so focus it after the button has taken the click.
  document.getElementById('new-tab').addEventListener('click', () => {
    find.focus();
    render();
  });
  document.getElementById('new-tab').addEventListener('pointerdown', (e) => e.preventDefault());

  // Restore: after a crash, reopen every Claude Code conversation that stopped.
  // The host answers 404 when it runs without -restore-command; then the button goes.
  const restoreButton = document.getElementById('restore');
  restoreButton.addEventListener('click', async () => {
    restoreButton.disabled = true;
    try {
      const opened = await api('POST', '/api/restore');
      onStatus(opened.length ? `Reopened ${opened.length}: ${opened.map((c) => c.title || c.id.slice(0, 8)).join(', ')}` : 'Nothing to reopen');
      await refresh();
    } catch (e) {
      if (e.message.includes('404')) restoreButton.hidden = true;
      onError(e);
    } finally {
      restoreButton.disabled = false;
    }
  });

  return {
    async start() {
      await refresh();
      timer = setInterval(refresh, POLL_MS);
      const first = windows.find((w) => w.active) || windows[0];
      if (first) select(first.id);
    },
    stop: () => clearInterval(timer),
    // Alt+N: the window whose tmux index is N, like tmux's own prefix+N.
    openIndex(n) {
      const w = windows.find((x) => x.index === n);
      if (w) open(w.id);
    },
    // Alt+Shift+Up / Alt+Shift+Down: move the open agent one place, like a drag.
    shift(delta) {
      const at = windows.findIndex((w) => w.id === current);
      const neighbour = windows[at + delta];
      if (at >= 0 && neighbour) move(current, neighbour.id, delta > 0);
    },
    // Alt+Down / Alt+Up: next or previous agent in the order shown, wrapping around.
    step(delta) {
      const order = ordered();
      if (!order.length) return;
      const at = order.findIndex((w) => w.id === current);
      open(order[(at + delta + order.length) % order.length].id);
    },
    focusFind() {
      find.focus();
      find.select();
      render();
    },
  };
}
