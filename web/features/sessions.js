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
// Folders nest. The host stores each as its path, segments joined by this, and
// lists every folder right after its parent, so the list in order is the tree.
const SEP = '\x1f';
const parentOf = (f) => f.slice(0, Math.max(f.lastIndexOf(SEP), 0));
const leafOf = (f) => f.slice(f.lastIndexOf(SEP) + 1);
const depthOf = (f) => (f ? f.split(SEP).length : 0);
const within = (f, path) => f === path || f.startsWith(path + SEP);
const pathLabel = (f) => f.split(SEP).join(' / ');

// A conversation without a name of any kind is shown by its id, the last resort.
const conversationName = (c) => c.name || c.id.slice(0, 8);

function ago(iso) {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`; // the picker reaches one day back
}

// One line of the Restore picker. textContent throughout: names and prompts are
// written by programs in the terminal.
function restoreRow(c) {
  const li = document.createElement('li');
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = c.id;
  box.checked = c.recent;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = conversationName(c);
  const meta = document.createElement('span');
  meta.className = 'meta';
  const where = [leafOf(c.folder), c.dir.split('/').pop(), ago(c.last)].filter(Boolean).join(' · ');
  meta.textContent = c.prompt ? `${where} — ${c.prompt}` : where;
  label.append(box, name, meta);
  li.append(label);
  return li;
}

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

export function createSessions({ onSelect, onError, onStatus = () => {}, focusTerminal, holdKeys = () => {}, onOpen = () => {}, onReachable = () => {} }) {
  const list = document.getElementById('tab-list');
  const find = document.getElementById('find');
  const menu = document.getElementById('tab-menu');
  let windows = [];
  let folders = [];
  const collapsed = loadCollapsed();
  let current = null;
  let highlighted = 0; // index into the visible rows while the field has focus
  let naming = false; // ⌘T opened the finder to name a new agent
  const findHint = document.getElementById('find').placeholder;
  function stopNaming() {
    naming = false;
    find.placeholder = findHint;
  }
  let timer = null;
  let unreachable = false; // the last poll failed, and its error is on screen

  async function refresh() {
    try {
      [windows, folders] = await Promise.all([api('GET', '/api/windows'), api('GET', '/api/folders')]);
    } catch (e) {
      unreachable = true;
      onError(e);
      return;
    }
    if (unreachable) onReachable();
    unreachable = false;
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
  const inSubtree = (f) => windows.filter((w) => within(folderOf(w), f));
  // Hidden when it, or any folder around it, is collapsed.
  const folded = (f) => [...collapsed].some((c) => within(f, c));
  const ancestorFolded = (f) => folded(parentOf(f)) && parentOf(f) !== '';

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
    if (naming) return [{ create: query() }]; // ⌘T: the only row is the agent being named
    const matches = visible();
    const name = query();
    if (!name || /^\d+$/.test(name)) return matches;
    const creates = matches.some((w) => w.name === name) ? [] : [{ create: name }];
    if (!folders.includes(name)) creates.push({ createFolder: name });
    return [...matches, ...creates];
  }

  // The list with nothing typed: folder headers, their windows unless collapsed
  // (the open one always shows, so you can see where you are), then the rest.
  // A folder inside a collapsed one is not shown at all.
  function tree() {
    const shown = (f) => inFolder(f).filter((w) => !folded(f) || w.id === current);
    const header = (f) => (ancestorFolded(f) ? [] : [{ header: f }]);
    return [...folders.flatMap((f) => [...header(f), ...shown(f)]), ...inFolder('')];
  }

  // Alt+1..9 follow the list as shown, top to bottom: collapsing a folder renumbers
  // the agents below it, and the ones it hides get no key.
  const hotkeyOrder = () => tree().filter((row) => row.id).slice(0, 9);

  function render() {
    const all = query() || naming ? rows() : tree(); // naming: ⌘T shows only the agent being named
    highlighted = Math.min(highlighted, Math.max(all.length - 1, 0));
    const searching = document.activeElement === find && (query() !== '' || naming);
    list.replaceChildren(...all.map((row, i) => {
      const li = rowElement(row);
      li.classList.toggle('highlighted', searching && i === highlighted);
      return li;
    }));
    list.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
    showCurrent();
  }

  // The top bar of a narrow screen names the open agent, with its state dot,
  // so you know where you are without opening the list.
  function showCurrent() {
    const w = windows.find((x) => x.id === current);
    const button = document.getElementById('menu');
    document.getElementById('top-name').textContent = w ? w.name : 'Agents'; // textContent: set by programs in the terminal
    if (w) button.dataset.state = stateOf(w);
    else delete button.dataset.state;
  }

  function rowElement(row) {
    if (row.create !== undefined) return createRow('create', row.create ? `+ New agent "${row.create}"` : '+ New agent', () => create(row.create));
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
    const inside = inSubtree(f);
    const li = document.createElement('li');
    li.className = 'folder';
    li.dataset.folder = f;
    li.style.setProperty('--depth', depthOf(f) - 1);
    li.setAttribute('aria-expanded', String(!collapsed.has(f)));
    li.dataset.state = ['bell', 'waiting', 'activity'].find((s) => inside.some((w) => stateOf(w) === s)) || 'idle';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = leafOf(f); // textContent: any client may name a folder
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = inside.length;
    const more = document.createElement('button');
    more.className = 'more';
    more.type = 'button';
    more.textContent = '⋯';
    more.setAttribute('aria-label', `Options for folder ${leafOf(f)}`);
    more.setAttribute('aria-haspopup', 'menu');
    li.append(name, dot, count, more);
    li.addEventListener('click', (e) => {
      if (dragged) return;
      if (e.target === more) showFolderMenu(f, more.getBoundingClientRect());
      else toggleFolder(f);
    });
    return li;
  }

  function showFolderMenu(f, anchor) {
    const moveTo = menuItem('Move to…', () => showParents(f, anchor), true);
    moveTo.disabled = !parentsFor(f).length;
    menu.replaceChildren(
      menuItem('New agent', () => newAgentIn(f)),
      menuItem('Rename', () => renameFolder(f)),
      moveTo,
      menuItem('Delete', () => deleteFolder(f)),
    );
    menu.showPopover();
    placeMenu(anchor);
    menu.querySelector('button').focus();
  }

  // Where folder f can go: any folder but itself, its own folders and where it already is.
  const parentsFor = (f) => [...folders.filter((p) => !within(p, f) && p !== parentOf(f)), ...(parentOf(f) ? [''] : [])];

  function showParents(f, anchor) {
    menu.replaceChildren(...parentsFor(f).map((p) => menuItem(p ? pathLabel(p) : 'Top level', () => nestFolder(f, p))));
    placeMenu(anchor);
    menu.querySelector('button').focus();
  }

  async function nestFolder(f, parent) {
    await api('PUT', `/api/folders/${encodeURIComponent(f)}/parent`, { name: parent }).catch(onError);
    carryCollapsed(f, parent ? parent + SEP + leafOf(f) : leafOf(f));
    collapsed.delete(parent); // you just put it there: show it
    saveCollapsed(collapsed);
    refresh();
  }

  // A folder that moves or is renamed keeps its own collapsed state, and so do the ones inside it.
  function carryCollapsed(old, now) {
    for (const c of [...collapsed]) {
      if (!within(c, old)) continue;
      collapsed.delete(c);
      collapsed.add(now + c.slice(old.length));
    }
    saveCollapsed(collapsed);
  }

  // Cancel creates nothing; an empty name makes an unnamed agent, as in the finder.
  function newAgentIn(f) {
    const name = prompt(`New agent in "${f}":`);
    if (name !== null) create(name.trim(), f);
  }

  async function renameFolder(f) {
    const name = prompt('Rename folder:', leafOf(f))?.trim();
    if (!name || name === leafOf(f)) return;
    await api('PATCH', `/api/folders/${encodeURIComponent(f)}`, { name }).catch(onError);
    carryCollapsed(f, parentOf(f) ? parentOf(f) + SEP + name : name);
    refresh();
  }

  // The agents inside are not closed: they go up to the folder around it, or loose.
  async function deleteFolder(f) {
    const where = parentOf(f) ? `in "${pathLabel(parentOf(f))}"` : 'outside any folder';
    if (!confirm(`Delete folder "${pathLabel(f)}" and the folders inside it? Its agents keep running, ${where}.`)) return;
    await api('DELETE', `/api/folders/${encodeURIComponent(f)}`).catch(onError);
    collapsed.delete(f);
    saveCollapsed(collapsed);
    refresh();
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
    li.style.setProperty('--depth', query() ? 0 : depthOf(folderOf(w)));
    li.setAttribute('aria-current', String(w.id === current));
    li.title = 'Double-click to rename';

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
    const key = hotkeyOrder().indexOf(w) + 1;
    if (key) hotkey.textContent = keyLabel(`Alt ${key}`);
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

  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-id], li.folder');
    if (!li || e.button !== 0 || e.target.closest('.more') || query()) return;
    drag = { li, x: e.clientX, y: e.clientY, on: false, moved: false, pointerId: e.pointerId, pointerType: e.pointerType };
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
    if (travel >= DRAG_PX) drag.moved = true;
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
  // A window dropped on a folder header goes into it. A dragged folder only lands
  // on another folder: on the middle of its row it goes inside, near an edge it
  // goes beside it. It never lands on itself or a folder of its own.
  function dropSpot(e, dragging = drag.li) {
    const isFolder = dragging.classList.contains('folder');
    const over = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches?.(isFolder ? 'li.folder' : 'li[data-id], li.folder') && el !== dragging);
    if (!over || (isFolder && within(over.dataset.folder, dragging.dataset.folder))) return null;
    if (!isFolder && over.classList.contains('folder')) return { over, into: true };
    const r = over.getBoundingClientRect();
    const [at, size] = [e.clientY - r.top, r.height];
    if (isFolder && at > size / 4 && at < size * 3 / 4) return { over, into: true };
    return { over, after: at > size / 2 };
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
    // Held still and let go on a phone = the tab's menu, not a drop.
    if (d.pointerType === 'touch' && !d.moved && d.li.dataset.id) {
      render();
      showHoldMenu(d.li.dataset.id);
    } else if (spot) await drop(d.li, spot);
    else render();
    setTimeout(() => (dragged = false)); // after the click this pointerup produces
  }

  // The phone has no × on its tabs. A hold opens this menu instead.
  const holdMenu = document.getElementById('hold-menu');
  function showHoldMenu(id) {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    holdMenu.dataset.id = id;
    holdMenu.querySelector('.hold-menu-name').textContent = w.name; // set by programs: text only
    holdMenu.showModal();
    holdMenu.openedAt = performance.now();
  }
  holdMenu.addEventListener('click', async (e) => {
    const action = e.target.closest('button')?.value;
    // The click of the very finger that opened the menu lands on its backdrop.
    if (e.target === holdMenu && performance.now() - holdMenu.openedAt < 400) return;
    if (e.target === holdMenu || action === 'cancel') return holdMenu.close(); // tap outside the card
    if (action !== 'close') return;
    holdMenu.close();
    await closeUndoable(holdMenu.dataset.id);
  });

  // A phone has no ⌘Z: the status line carries an Undo button for a few seconds.
  const undo = document.getElementById('undo-close');
  let undoTimer = 0;
  function offerUndo() {
    onStatus('Closed.');
    undo.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (undo.hidden = true), 8000);
  }
  undo.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the soft keyboard as it was
  undo.addEventListener('click', () => {
    undo.hidden = true;
    reopenLast();
  });

  async function reopenLast() {
    try {
      const { id } = await api('POST', '/api/windows/reopen');
      onStatus('');
      await refresh();
      open(id);
    } catch (e) {
      onStatus(e.message.includes('nothing') ? 'Nothing to reopen' : e.message);
    }
  }

  // Hide the window for a while (⌘Z brings it back) and move to its neighbour.
  async function closeUndoable(id) {
    const at = windows.findIndex((w) => w.id === id);
    if (at < 0) return;
    const next = windows[at + 1] || windows[at - 1];
    try {
      await api('POST', `/api/windows/${encodeURIComponent(id)}/close`);
    } catch (e) {
      return onError(e);
    }
    offerUndo();
    await refresh();
    if (id === current) open(next ? next.id : null);
  }


  // Dropped next to a window, the dragged one also joins that window's folder,
  // so dragging beside a loose tab is how a window leaves its folder.
  async function drop(li, spot) {
    if (li.classList.contains('folder')) {
      if (spot.into) return nestFolder(li.dataset.folder, spot.over.dataset.folder);
      return moveFolder(li.dataset.folder, spot.over.dataset.folder, spot.after);
    }
    const folder = spot.over.dataset.folder;
    if (!spot.into) await move(li.dataset.id, spot.over.dataset.id, spot.after, false);
    if (folder !== li.dataset.folder) await setFolder(li.dataset.id, folder);
    await refresh();
  }

  async function moveFolder(name, target, after) {
    await api('POST', `/api/folders/${encodeURIComponent(name)}/move`, { target, after }).catch(onError);
    carryCollapsed(name, parentOf(target) ? parentOf(target) + SEP + leafOf(name) : leafOf(name));
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
    menu.replaceChildren(menuItem('Rename', () => rename(w)), menuItem('Duplicate', () => duplicate(w.id)), moveTo, menuItem('Close', () => remove(w)));
    menu.showPopover();
    placeMenu(anchor);
    menu.querySelector('button:not(:disabled)').focus();
  }

  function showFolders(w, anchor) {
    const here = folderOf(w);
    const targets = folders.filter((f) => f !== here).map((f) => menuItem(pathLabel(f), () => moveToFolder(w, f)));
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
    onOpen();
    focusTerminal();
    list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  const create = (name, folder = '') => openNew('/api/windows', { name }, folder);
  const duplicate = (id) => openNew(`/api/windows/${encodeURIComponent(id)}/duplicate`);

  // Keys typed while the host makes the window go to it, not to the agent on
  // screen. If it fails, they go where they went before: the current window.
  // Duplicate passes no folder: the host already put the copy in the original's.
  async function openNew(path, body, folder = '') {
    holdKeys();
    try {
      const { id } = await api('POST', path, body);
      if (folder) await setFolder(id, folder);
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
      stopNaming();
      if (row?.create !== undefined) create(row.create);
      else if (row?.createFolder !== undefined) addFolder(row.createFolder);
      else if (row) open(row.id);
      else if (!query()) create(''); // empty field + Enter: a fresh agent
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stopNaming();
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
  // A tap on a result would first blur the finder, which redraws the list
  // before the click lands. Keeping focus on pointerdown lets the tap through.
  list.addEventListener('pointerdown', (e) => {
    if (document.activeElement === find) e.preventDefault();
  });
  find.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== find) stopNaming(); // clicked away: back to finding
    render(); // drop the highlight
  }));
  // Tapping "+" must not blur the finder on the way (the tap lands on the button,
  // which would steal focus), so focus it after the button has taken the click.
  document.getElementById('new-tab').addEventListener('click', () => {
    find.focus();
    render();
  });
  document.getElementById('new-tab').addEventListener('pointerdown', (e) => e.preventDefault());

  // Restore: after a crash, pick which stopped Claude Code conversations come back.
  // The host answers 404 when it runs without -restore-command; then the button goes.
  const restoreButton = document.getElementById('restore');
  const restoreDialog = document.getElementById('restore-dialog');
  const restoreList = document.getElementById('restore-list');
  const restoreGo = document.getElementById('restore-go');
  const picked = () => [...restoreList.querySelectorAll('input:checked')].map((box) => box.value);
  const countPicked = () => {
    const n = picked().length;
    restoreGo.textContent = n ? `Reopen ${n}` : 'Reopen';
    restoreGo.disabled = !n;
  };
  restoreList.addEventListener('change', countPicked);

  restoreButton.addEventListener('click', async () => {
    restoreButton.disabled = true;
    try {
      const stopped = await api('GET', '/api/restore');
      if (!stopped.length) return onStatus('Nothing to reopen');
      restoreList.replaceChildren(...stopped.map(restoreRow));
      countPicked();
      restoreDialog.showModal();
    } catch (e) {
      if (e.message.includes('404')) restoreButton.hidden = true;
      onError(e);
    } finally {
      restoreButton.disabled = false;
    }
  });

  restoreDialog.addEventListener('close', async () => {
    if (restoreDialog.returnValue !== 'go') return;
    try {
      const opened = await api('POST', '/api/restore', { ids: picked() });
      onStatus(opened.length ? `Reopened ${opened.length}: ${opened.map(conversationName).join(', ')}` : 'Nothing to reopen');
      await refresh();
    } catch (e) {
      onError(e);
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
    // Alt+N: the Nth agent in the list as shown.
    openIndex(n) {
      const w = hotkeyOrder()[n - 1];
      if (w) open(w.id);
    },
    // Alt+Shift+Up / Alt+Shift+Down: move the open agent one place in the order
    // shown, like a drag: next to a window in another folder, it joins that folder.
    async shift(delta) {
      const order = ordered();
      const at = order.findIndex((w) => w.id === current);
      const neighbour = order[at + delta];
      if (at < 0 || !neighbour) return;
      await move(current, neighbour.id, delta > 0, false);
      if (folderOf(neighbour) !== folderOf(order[at])) await setFolder(current, folderOf(neighbour));
      await refresh();
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
    // ⌘T: the finder in "new agent" mode. Enter creates whatever was typed,
    // even a name some agent already contains; empty, an unnamed agent.
    newAgent() {
      naming = true;
      find.value = '';
      find.placeholder = 'Name the new agent';
      find.focus();
      render();
    },
    // ⌘W: close the open agent, undoably (⌘Z), and move to its neighbour.
    closeCurrent: () => current && closeUndoable(current),
    // ⌘E: the ⋯ menu's Duplicate, for the open agent.
    duplicateCurrent: () => current && duplicate(current),
    reopenLast,
  };
}
