package sessions

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Conversation is one Claude Code transcript that can be reopened.
type Conversation struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Dir   string `json:"dir"`
	mtime time.Time
}

// Claude points at the state Claude Code keeps in ~/.claude: a transcript per
// conversation under projects/, and a registry of running processes under
// sessions/. Reading them is how a crash (the WSL dying, tmux killed) is undone
// without reopening every agent by hand.
type Claude struct {
	Home    string // usually ~/.claude
	Command string // what reopens one conversation; its id is appended
}

// validConversationID accepts only a lowercase UUID: it ends up on a command line.
func validConversationID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, r := range id {
		dash := i == 8 || i == 13 || i == 18 || i == 23
		if dash != (r == '-') || (!dash && !strings.ContainsRune("0123456789abcdef", r)) {
			return false
		}
	}
	return true
}

// Stopped lists conversations touched since `since` that no live process holds.
func (c Claude) Stopped(since time.Time) ([]Conversation, error) {
	running := c.running()
	paths, err := filepath.Glob(filepath.Join(c.Home, "projects", "*", "*.jsonl"))
	if err != nil {
		return nil, err
	}
	var list []Conversation
	for _, p := range paths {
		id := strings.TrimSuffix(filepath.Base(p), ".jsonl")
		st, err := os.Stat(p)
		if err != nil || st.ModTime().Before(since) || running[id] || !validConversationID(id) {
			continue
		}
		if conv, ok := describe(p); ok {
			conv.ID, conv.mtime = id, st.ModTime()
			list = append(list, conv)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].mtime.Before(list[j].mtime) })
	return list, nil
}

// running returns the ids of conversations a live claude process holds. A
// registry file can outlive its process and the pid be reused, so the process
// start time recorded in the file must match the live process too. An unknown
// start time never matches: an empty string on both sides is not a live process.
func (c Claude) running() map[string]bool {
	ids := map[string]bool{}
	files, _ := filepath.Glob(filepath.Join(c.Home, "sessions", "*.json"))
	for _, f := range files {
		var reg struct {
			PID       int    `json:"pid"`
			SessionID string `json:"sessionId"`
			ProcStart string `json:"procStart"`
		}
		if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &reg) == nil && reg.ProcStart != "" && procStart(reg.PID) == reg.ProcStart {
			ids[reg.SessionID] = true
		}
	}
	return ids
}

// procStart is the process start time in the format Claude Code records it:
// on Linux field 22 of /proc/PID/stat, elsewhere (macOS) what
// `LC_ALL=C TZ=UTC ps -o lstart= -p PID` prints, trimmed.
func procStart(pid int) string {
	if runtime.GOOS != "linux" {
		cmd := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid))
		cmd.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC")
		out, _ := cmd.Output()
		return strings.TrimSpace(string(out))
	}
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return ""
	}
	// Field 22 is counted after the command name, which is in parentheses and
	// may itself contain spaces.
	fields := strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+1:]))
	if len(fields) < 20 {
		return ""
	}
	return fields[19]
}

// describe reads the working directory and the latest title (/rename) of one
// transcript. A directory that is gone cannot be reopened, so it is skipped.
func describe(path string) (Conversation, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Conversation{}, false
	}
	defer f.Close()
	var conv Conversation
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 64*1024*1024) // a tool result can be megabytes on one line
	for sc.Scan() {
		var line struct {
			Cwd         string `json:"cwd"`
			CustomTitle string `json:"customTitle"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil {
			continue
		}
		if line.Cwd != "" {
			conv.Dir = line.Cwd
		}
		if line.CustomTitle != "" {
			conv.Title = line.CustomTitle
		}
	}
	if st, err := os.Stat(conv.Dir); err != nil || !st.IsDir() {
		return Conversation{}, false
	}
	return conv, true
}

// Restore reopens, one tmux window each, the conversations touched in the last
// `window` that no process holds anymore. Each window runs the user's shell
// interactively (so PATH and aliases from the rc files apply), which runs
// Command plus the id and then stays as a plain shell, like a window opened by
// hand. An id reopened moments ago is skipped: its process may not have
// registered yet, and a second tap would open it twice.
func (r *Restorer) Restore(window time.Duration) ([]Conversation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	list, err := r.Claude.Stopped(now.Add(-window))
	if err != nil {
		return nil, err
	}
	opened := []Conversation{}
	for _, c := range list {
		if now.Sub(r.recent[c.ID]) < 2*time.Minute {
			continue
		}
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/sh"
		}
		line := r.Claude.Command + " " + c.ID + "; exec " + strconv.Quote(shell)
		args := []string{"new-window", "-d", "-t", "=" + r.Tmux.Session + ":", "-n", windowName(c), "-c", c.Dir, shell, "-ic", line}
		if _, err := r.Tmux.inSession(args...); err != nil {
			return opened, err
		}
		r.recent[c.ID] = now
		opened = append(opened, c)
	}
	return opened, nil
}

// Restorer serialises restores so two taps cannot race each other.
type Restorer struct {
	Tmux   Tmux
	Claude Claude
	mu     sync.Mutex
	recent map[string]time.Time
}

// NewRestorer wires a Restorer; command is what reopens one conversation.
func NewRestorer(tm Tmux, claudeHome, command string) *Restorer {
	return &Restorer{Tmux: tm, Claude: Claude{Home: claudeHome, Command: command}, recent: map[string]time.Time{}}
}

// windowName is the conversation's title when tmux accepts it, else its id.
func windowName(c Conversation) string {
	name := []rune(strings.TrimRight(c.Title, "; "))
	if len(name) > 64 {
		name = name[:64]
	}
	if validName(string(name)) != nil || len(name) == 0 {
		return c.ID[:8]
	}
	return string(name)
}
