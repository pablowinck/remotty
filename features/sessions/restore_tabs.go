package sessions

import (
	"cmp"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// A crash takes tmux down, and with it the names the user gave the tabs and the
// folders they were in: Restore brought agents back as "8f3a91c2". So Remember
// notes, for each running conversation, the tab it runs in, and Restore puts it
// back under that name, in that folder.

// tabMemory is a conversation's tab as last seen. The folder path holds its
// ancestors, so a nested folder can be rebuilt from it alone.
type tabMemory struct {
	Name   string    `json:"name"` // "" when tmux named the tab itself ("zsh", "node")
	Folder string    `json:"folder"`
	Seen   time.Time `json:"seen"`
}

type tabMemories map[string]tabMemory

// forgetAfter drops what was not seen for a week: the picker reaches one day back.
const forgetAfter = 7 * 24 * time.Hour

func (r *Restorer) loadTabs() tabMemories {
	tabs := tabMemories{}
	if b, err := os.ReadFile(r.TabsFile); err == nil {
		json.Unmarshal(b, &tabs) // a broken file is as good as none: names fall back to the titles
	}
	return tabs
}

// apply names c as its tab was and puts it in the folder the tab was in.
func (tabs tabMemories) apply(c Conversation) Conversation {
	if t, ok := tabs[c.ID]; ok {
		c.Name = cmp.Or(t.Name, c.Name)
		c.Folder = t.Folder
	}
	return c
}

// Remember notes the tab of every running conversation. It merges into what it
// noted before and never replaces it: right after a crash tmux comes back empty,
// and that is exactly when the old names are needed.
func (r *Restorer) Remember() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	running := r.Claude.running()
	if len(running) == 0 {
		return nil
	}
	panes, err := r.Tmux.panes()
	if err != nil {
		return err
	}
	tabs, now, parents := r.loadTabs(), time.Now(), parentPIDs()
	for id, pid := range running {
		if tab, ok := paneOf(pid, panes, parents); ok {
			tab.Seen = now
			tabs[id] = tab
		}
	}
	for id, t := range tabs {
		if now.Sub(t.Seen) > forgetAfter {
			delete(tabs, id)
		}
	}
	return writeFileAtomic(r.TabsFile, tabs)
}

// panes maps each pane's shell pid to its window's tab. The folder goes last:
// tmux escapes a tab in window_name but not in an option (see listFormat).
func (t Tmux) panes() (map[int]tabMemory, error) {
	out, err := t.inSession("list-panes", "-s", "-t", "="+t.Session, "-F", "#{pane_pid}\t#{automatic-rename}\t#{window_name}\t#{"+folderOption+"}")
	if err != nil {
		return nil, err
	}
	panes := map[int]tabMemory{}
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		f := strings.SplitN(line, "\t", 4)
		pid, err := strconv.Atoi(f[0])
		if len(f) != 4 || err != nil {
			continue
		}
		tab := tabMemory{Folder: f[3]}
		if f[1] == "0" { // named by someone, not by tmux after the running command
			tab.Name = f[2]
		}
		panes[pid] = tab
	}
	return panes, nil
}

// paneOf climbs from a claude process to the pane whose shell started it.
func paneOf(pid int, panes map[int]tabMemory, parents map[int]int) (tabMemory, bool) {
	for range 64 { // a cycle in a racy ps listing must not hang us
		if tab, ok := panes[pid]; ok {
			return tab, true
		}
		if pid = parents[pid]; pid <= 1 {
			break
		}
	}
	return tabMemory{}, false
}

// parentPIDs maps every pid to its parent, from one ps (Linux and macOS alike).
func parentPIDs() map[int]int {
	out, _ := exec.Command("ps", "-A", "-o", "pid=,ppid=").Output()
	parents := map[int]int{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 == nil && err2 == nil {
			parents[pid] = ppid
		}
	}
	return parents
}

// writeFileAtomic replaces path in one rename, so a crash mid-write (the very
// event this file is for) cannot leave it half written.
func writeFileAtomic(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
