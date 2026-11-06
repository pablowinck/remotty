package sessions

import (
	"bufio"
	"cmp"
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
	ID     string    `json:"id"`
	Name   string    `json:"name"`   // the window's name: as the tab was called, else /rename, else Claude's own title; "" if none
	Dir    string    `json:"dir"`    // where it ran, and reopens
	Prompt string    `json:"prompt"` // the last thing typed, to tell apart conversations with no name
	Last   time.Time `json:"last"`   // its last message
	Folder string    `json:"folder"` // the folder its tab was in, "" for none
	Recent bool      `json:"recent"` // stopped within RestoreWindow: what a crash left, so the picker ticks it
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

// Stopped lists, newest first, the conversations with a message since `since`
// that no live process holds. The file's mtime does not say that: Claude Code
// rewrites a transcript without a new message (cost, title), and conversations
// idle for days kept coming back. mtime is only a cheap first cut, since a file
// is never older than its last line.
func (c Claude) Stopped(since time.Time) ([]Conversation, error) {
	running := c.running()
	paths, err := filepath.Glob(filepath.Join(c.Home, "projects", "*", "*.jsonl"))
	if err != nil {
		return nil, err
	}
	list := []Conversation{}
	for _, p := range paths {
		id := strings.TrimSuffix(filepath.Base(p), ".jsonl")
		st, err := os.Stat(p)
		if _, held := running[id]; err != nil || held || st.ModTime().Before(since) || !validConversationID(id) {
			continue
		}
		if conv, ok := describe(p, st.ModTime()); ok && !conv.Last.Before(since) {
			conv.ID = id
			list = append(list, conv)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Last.After(list[j].Last) })
	return list, nil
}

// find describes one stopped conversation by id, however old: the id comes
// from the browser, so it must name a real transcript no process holds.
func (c Claude) find(id string, running map[string]int) (Conversation, bool) {
	if _, held := running[id]; held || !validConversationID(id) {
		return Conversation{}, false
	}
	paths, _ := filepath.Glob(filepath.Join(c.Home, "projects", "*", id+".jsonl")) // a valid id holds no glob character
	if len(paths) == 0 {
		return Conversation{}, false
	}
	st, err := os.Stat(paths[0])
	if err != nil {
		return Conversation{}, false
	}
	conv, ok := describe(paths[0], st.ModTime())
	conv.ID = id
	return conv, ok
}

// running maps the ids of conversations a live claude process holds to its pid. A
// registry file can outlive its process and the pid be reused, so the process
// start time recorded in the file must match the live process too. An unknown
// start time never matches: an empty string on both sides is not a live process.
func (c Claude) running() map[string]int {
	type registry struct {
		PID       int    `json:"pid"`
		SessionID string `json:"sessionId"`
		ProcStart string `json:"procStart"`
	}
	var regs []registry
	var pids []int
	files, _ := filepath.Glob(filepath.Join(c.Home, "sessions", "*.json"))
	for _, f := range files {
		var reg registry
		if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &reg) == nil && reg.ProcStart != "" {
			regs, pids = append(regs, reg), append(pids, reg.PID)
		}
	}
	starts := procStarts(pids)
	ids := map[string]int{}
	for _, reg := range regs {
		if starts[reg.PID] == reg.ProcStart {
			ids[reg.SessionID] = reg.PID
		}
	}
	return ids
}

// procStarts maps each live pid to its start time in the format Claude Code
// records it: on Linux field 22 of /proc/PID/stat, elsewhere (macOS) what
// `LC_ALL=C TZ=UTC ps -o lstart= -p PID` prints, trimmed. One ps for all pids:
// ~/.claude/sessions keeps hundreds of stale files, one fork each was slow.
func procStarts(pids []int) map[int]string {
	if runtime.GOOS == "linux" {
		starts := map[int]string{}
		for _, pid := range pids {
			if s := procStat(pid); s != "" {
				starts[pid] = s
			}
		}
		return starts
	}
	if len(pids) == 0 {
		return nil
	}
	list := make([]string, len(pids))
	for i, pid := range pids {
		list[i] = strconv.Itoa(pid)
	}
	cmd := exec.Command("ps", "-o", "pid=,lstart=", "-p", strings.Join(list, ","))
	cmd.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC")
	out, _ := cmd.Output() // exits 1 when some pid is gone, still printing the others
	return parsePS(string(out))
}

// parsePS reads `ps -o pid=,lstart=` lines. lstart pads a one-digit day with a
// second space ("Sep  5"), as Claude Code stores it, so the rest is kept as is.
func parsePS(out string) map[int]string {
	starts := map[int]string{}
	for _, line := range strings.Split(out, "\n") {
		pid, start, _ := strings.Cut(strings.TrimSpace(line), " ")
		if n, err := strconv.Atoi(pid); err == nil {
			starts[n] = strings.TrimSpace(start)
		}
	}
	return starts
}

func procStat(pid int) string {
	if fields := statFields(pid); len(fields) >= 20 {
		return fields[19]
	}
	return ""
}

// statFields splits /proc/PID/stat from field 3 on: fields are counted after
// the command name, which is in parentheses and may itself contain spaces.
func statFields(pid int) []string {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return nil
	}
	return strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+1:]))
}

// userShell is the shell windows run, so PATH and aliases from its rc files apply.
func userShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/sh"
}

// describe reads one transcript: its working directory, its name (/rename
// wins over the title Claude Code gives it), its last prompt and the time of
// its last message, mtime when no line has one. A directory that is gone cannot
// be reopened, so it is skipped.
func describe(path string, mtime time.Time) (Conversation, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Conversation{}, false
	}
	defer f.Close()
	var conv Conversation
	var custom, ai, last string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 64*1024*1024) // a tool result can be megabytes on one line
	for sc.Scan() {
		var line struct {
			Cwd         string `json:"cwd"`
			CustomTitle string `json:"customTitle"`
			AITitle     string `json:"aiTitle"`
			LastPrompt  string `json:"lastPrompt"`
			Timestamp   string `json:"timestamp"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil {
			continue
		}
		conv.Dir = cmp.Or(line.Cwd, conv.Dir)
		custom, ai = cmp.Or(line.CustomTitle, custom), cmp.Or(line.AITitle, ai)
		conv.Prompt = cmp.Or(line.LastPrompt, conv.Prompt)
		last = max(last, line.Timestamp) // RFC 3339 in UTC: text order is time order
	}
	conv.Name, conv.Prompt = cmp.Or(custom, ai), clip(conv.Prompt, 120)
	conv.Last = mtime
	if t, err := time.Parse(time.RFC3339, last); err == nil {
		conv.Last = t
	}
	if st, err := os.Stat(conv.Dir); err != nil || !st.IsDir() {
		return Conversation{}, false
	}
	return conv, true
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// Stopped lists what the picker offers: conversations stopped within ListWindow,
// named as their tab was, minus those reopened moments ago (their process may
// not have registered yet).
func (r *Restorer) Stopped() ([]Conversation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	list, err := r.Claude.Stopped(now.Add(-ListWindow))
	if err != nil {
		return nil, err
	}
	tabs := r.loadTabs()
	shown := []Conversation{}
	for _, c := range list {
		if now.Sub(r.recent[c.ID]) >= 2*time.Minute {
			c.Recent = now.Sub(c.Last) < RestoreWindow
			shown = append(shown, tabs.apply(c))
		}
	}
	return shown, nil
}

// Restore reopens the conversations ids, one tmux window each, named and in
// the folder their tab had. Each window runs the user's shell interactively (so
// PATH and aliases from the rc files apply), which runs Command plus the id and
// then stays as a plain shell, like a window opened by hand. An id reopened
// moments ago is skipped, or a second tap would open it twice.
func (r *Restorer) Restore(ids []string) ([]Conversation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now, running, tabs := time.Now(), r.Claude.running(), r.loadTabs()
	opened := []Conversation{}
	for _, id := range ids {
		c, ok := r.Claude.find(id, running)
		if !ok || now.Sub(r.recent[c.ID]) < 2*time.Minute {
			continue
		}
		c = tabs.apply(c)
		if err := r.open(c); err != nil {
			return opened, err
		}
		r.recent[c.ID] = now
		opened = append(opened, c)
	}
	return opened, nil
}

func (r *Restorer) open(c Conversation) error {
	shell := userShell()
	line := r.Claude.Command + " " + c.ID + "; exec " + strconv.Quote(shell)
	out, err := r.Tmux.inSession("new-window", "-d", "-P", "-F", "#{window_id}", "-t", "="+r.Tmux.Session+":",
		"-n", windowName(c), "-c", c.Dir, shell, "-ic", line)
	if err != nil || c.Folder == "" {
		return err
	}
	r.Tmux.EnsureFolder(c.Folder) // a folder that cannot come back leaves the agent outside one, still open
	r.Tmux.SetFolder(strings.TrimSpace(out), c.Folder)
	return nil
}

// Restorer serialises restores so two taps cannot race each other.
type Restorer struct {
	Tmux     Tmux
	Claude   Claude
	TabsFile string // where Remember keeps each conversation's tab name and folder
	mu       sync.Mutex
	recent   map[string]time.Time
}

// NewRestorer wires a Restorer; command is what reopens one conversation.
func NewRestorer(tm Tmux, claudeHome, command, tabsFile string) *Restorer {
	return &Restorer{Tmux: tm, Claude: Claude{Home: claudeHome, Command: command}, TabsFile: tabsFile, recent: map[string]time.Time{}}
}

// windowName is the conversation's name when tmux accepts it, else its id.
func windowName(c Conversation) string {
	name := []rune(strings.TrimRight(c.Name, "; "))
	if len(name) > 64 {
		name = name[:64]
	}
	if validName(string(name)) != nil || len(name) == 0 {
		return c.ID[:8]
	}
	return string(name)
}
