package sessions

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeClaude lays out a ~/.claude with one transcript per id, each recording dir as its cwd.
func fakeClaude(t *testing.T, dir string, ids ...string) string {
	t.Helper()
	home := t.TempDir()
	proj := filepath.Join(home, "projects", "-some-project")
	os.MkdirAll(proj, 0o700)
	os.MkdirAll(filepath.Join(home, "sessions"), 0o700)
	for _, id := range ids {
		body := `{"type":"user","cwd":"` + dir + `"}` + "\n" + `{"type":"custom-title","customTitle":"titulo-` + id[:4] + `"}` + "\n"
		os.WriteFile(filepath.Join(proj, id+".jsonl"), []byte(body), 0o600)
	}
	return home
}

const (
	idA = "aaaaaaaa-1111-2222-3333-444444444444"
	idB = "bbbbbbbb-1111-2222-3333-444444444444"
)

func TestRestoreReopensStoppedConversationsInTheirDirectory(t *testing.T) {
	tm := newTestTmux(t)
	work, _ := filepath.EvalSymlinks(t.TempDir()) // macOS: /var is /private/var, as tmux reports it
	home := fakeClaude(t, work, idA, idB)
	// idB is held by a live process: this test's own pid, with its real start time.
	reg := `{"pid":` + strconv.Itoa(os.Getpid()) + `,"sessionId":"` + idB + `","procStart":"` + procStarts([]int{os.Getpid()})[os.Getpid()] + `"}`
	os.WriteFile(filepath.Join(home, "sessions", "1.json"), []byte(reg), 0o600)
	t.Setenv("SHELL", "/bin/sh")

	r := NewRestorer(tm, home, "echo reaberto", filepath.Join(t.TempDir(), "tabs.json"))
	list, err := r.Stopped()
	if err != nil || len(list) != 1 || list[0].ID != idA || !list[0].Recent {
		t.Fatalf("want only %s offered, ticked, got %+v (%v)", idA, list, err)
	}
	// A running conversation, or anything that is not a stopped transcript, is
	// never opened, whatever the browser asks.
	opened, err := r.Restore([]string{idB, "x; touch /tmp/pwned", idA})
	if err != nil {
		t.Fatal(err)
	}
	if len(opened) != 1 || opened[0].ID != idA {
		t.Fatalf("want only %s reopened, got %+v", idA, opened)
	}
	w := findWindow(t, tm, "titulo-aaaa")
	var out string
	for i := 0; i < 50 && !strings.Contains(out, "reaberto "+idA); i++ {
		time.Sleep(50 * time.Millisecond)
		out, _ = tm.run("capture-pane", "-p", "-t", w)
	}
	if !strings.Contains(out, "reaberto "+idA) {
		t.Fatalf("the window did not run the command with the id:\n%s", out)
	}
	cwd, _ := tm.run("display-message", "-p", "-t", w, "#{pane_current_path}")
	if strings.TrimSpace(cwd) != work {
		t.Fatalf("window opened in %q, want %q", strings.TrimSpace(cwd), work)
	}

	// A second tap right away must not open the same conversation twice, nor offer it.
	again, err := r.Restore([]string{idA})
	if err != nil || len(again) != 0 {
		t.Fatalf("second restore reopened %+v (%v)", again, err)
	}
	if list, _ := r.Stopped(); len(list) != 0 {
		t.Fatalf("a conversation just reopened is still offered: %+v", list)
	}
}

func TestRestoreSkipsOldTranscriptsAndBadIDs(t *testing.T) {
	tm := newTestTmux(t)
	work := t.TempDir()
	home := fakeClaude(t, work, idA, "not-a-uuid-and-could-be-a-command;x")
	old := time.Now().Add(-3 * time.Hour)
	os.Chtimes(filepath.Join(home, "projects", "-some-project", idA+".jsonl"), old, old)

	list, err := Claude{Home: home}.Stopped(time.Now().Add(-time.Hour))
	if err != nil || len(list) != 0 {
		t.Fatalf("want nothing to restore, got %+v (%v)", list, err)
	}
	// Anchor: the same transcript counts when the window reaches back far enough.
	if list, _ := (Claude{Home: home}).Stopped(old.Add(-time.Minute)); len(list) != 1 || list[0].ID != idA {
		t.Fatalf("an old transcript inside the window was not found: %+v", list)
	}
	_ = tm
}

// procStart must read the start time in the exact format Claude Code writes in
// ~/.claude/sessions: /proc's clock ticks on Linux, `ps -o lstart=` in UTC
// elsewhere. It used to read /proc only, so on macOS every conversation looked
// stopped and Restore reopened agents that were still running.
func TestProcStartMatchesClaudeCodesFormat(t *testing.T) {
	got := procStarts([]int{os.Getpid()})[os.Getpid()]
	want := regexp.MustCompile(`^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$`)
	if runtime.GOOS == "linux" {
		want = regexp.MustCompile(`^\d+$`)
	}
	if !want.MatchString(got) {
		t.Fatalf("procStart(self) = %q, want it to match %s", got, want)
	}
	if procStarts([]int{1<<22 + 1})[1<<22+1] != "" { // above every pid_max: no such process
		t.Fatal("a missing process must have no start time")
	}
}

// A registry left by a process that is gone must not hold its conversation,
// even when neither side knows a start time.
func TestAStaleRegistryDoesNotHoldItsConversation(t *testing.T) {
	home := fakeClaude(t, t.TempDir(), idA)
	reg := `{"pid":` + strconv.Itoa(1<<22+1) + `,"sessionId":"` + idA + `","procStart":""}`
	os.WriteFile(filepath.Join(home, "sessions", "1.json"), []byte(reg), 0o600)
	if list, _ := (Claude{Home: home}).Stopped(time.Now().Add(-time.Hour)); len(list) != 1 {
		t.Fatalf("want the conversation of a dead process listed as stopped, got %+v", list)
	}
}

func findWindow(t *testing.T, tm Tmux, name string) string {
	t.Helper()
	windows, _ := tm.List()
	for _, w := range windows {
		if w.Name == name {
			return w.ID
		}
	}
	t.Fatalf("no window named %q in %+v", name, windows)
	return ""
}

// One ps call answers for every pid; a one-digit day keeps its double space,
// as Claude Code wrote it, or a running conversation would look stopped.
func TestParsePSKeepsLstartAsPsPrintsIt(t *testing.T) {
	got := parsePS("  812 Fri Sep  5 09:03:07 2026\n91234 Thu Sep 25 22:10:00 2026\n")
	want := map[int]string{812: "Fri Sep  5 09:03:07 2026", 91234: "Thu Sep 25 22:10:00 2026"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsePS = %q, want %q", got, want)
	}
}

// writeTranscript writes one transcript of lines and sets its mtime.
func writeTranscript(t *testing.T, home, id string, mtime time.Time, lines ...string) {
	t.Helper()
	p := filepath.Join(home, "projects", "-some-project", id+".jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	os.Chtimes(p, mtime, mtime)
}

func stamp(at time.Time) string {
	return `{"type":"user","timestamp":"` + at.UTC().Format(time.RFC3339Nano) + `"}`
}

// Claude Code rewrites a transcript without a new message (cost, title): the
// file is fresh, the conversation is days old, and Restore kept reopening it.
func TestStoppedGoesByTheLastMessageNotTheFile(t *testing.T) {
	work := t.TempDir()
	home := fakeClaude(t, work, idA, idB)
	now := time.Now()
	cwd := `{"cwd":"` + work + `"}`
	writeTranscript(t, home, idA, now, cwd, stamp(now.Add(-72*time.Hour)), `{"type":"cost-state"}`)
	writeTranscript(t, home, idB, now, cwd, stamp(now.Add(-10*time.Minute)), `{"type":"cost-state"}`)

	list, err := Claude{Home: home}.Stopped(now.Add(-24 * time.Hour))
	if err != nil || len(list) != 1 || list[0].ID != idB {
		t.Fatalf("want only the conversation with a recent message, got %+v (%v)", list, err)
	}
	if d := now.Sub(list[0].Last); d < 9*time.Minute || d > 11*time.Minute {
		t.Fatalf("Last = %v, want its message's time, 10 min ago", list[0].Last)
	}
}

// Most conversations are never /renamed but all get a title from Claude Code:
// without it they came back named by a hash. /rename still wins.
func TestNameFallsBackFromRenameToClaudesTitle(t *testing.T) {
	work := t.TempDir()
	home := fakeClaude(t, work)
	now := time.Now()
	cwd := `{"cwd":"` + work + `"}`
	writeTranscript(t, home, idA, now, cwd, `{"type":"ai-title","aiTitle":"Crashes recorrentes no FIFA"}`, `{"type":"last-prompt","lastPrompt":"ve o log"}`)
	writeTranscript(t, home, idB, now, cwd, `{"type":"ai-title","aiTitle":"titulo da ia"}`, `{"type":"custom-title","customTitle":"meu-nome"}`, `{"type":"ai-title","aiTitle":"titulo da ia"}`)

	names := map[string]string{}
	list, _ := Claude{Home: home}.Stopped(now.Add(-time.Hour))
	for _, c := range list {
		names[c.ID] = c.Name
		if c.ID == idA && c.Prompt != "ve o log" {
			t.Fatalf("prompt = %q", c.Prompt)
		}
	}
	if names[idA] != "Crashes recorrentes no FIFA" || names[idB] != "meu-nome" {
		t.Fatalf("names = %q", names)
	}
}

// The tab's own name and folder outlive tmux: Remember notes them while the
// agent runs, Restore brings both back after the server is gone, nested folder included.
func TestRestoreBringsBackTheTabsNameAndFolder(t *testing.T) {
	tm := newTestTmux(t)
	work, _ := filepath.EvalSymlinks(t.TempDir())
	home := fakeClaude(t, work, idA)
	t.Setenv("SHELL", "/bin/sh")
	tm.AddFolder("movvia")
	tm.NestFolder(mustAdd(t, tm, "jobs"), "movvia")
	nested := "movvia" + folderSep + "jobs"
	out, _ := tm.run("new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_pid}", "-t", "=main:", "-n", "fifa crash", "sleep 60")
	id, panePID, _ := strings.Cut(strings.TrimSpace(out), "\t")
	tm.SetFolder(id, nested)
	auto, _ := tm.run("new-window", "-d", "-P", "-F", "#{pane_pid}", "-t", "=main:", "sleep 60") // tmux names this one
	// The "claude" of each conversation: the panes' own processes, with their real start times.
	register(t, home, "1", panePID, idA)
	register(t, home, "2", strings.TrimSpace(auto), idB)

	tabs := filepath.Join(t.TempDir(), "tabs.json")
	r := NewRestorer(tm, home, "echo reaberto", tabs)
	if err := r.Remember(); err != nil {
		t.Fatal(err)
	}
	saved := r.loadTabs()
	if saved[idA].Name != "fifa crash" || saved[idA].Folder != nested {
		t.Fatalf("remembered %+v", saved)
	}
	if t2, ok := saved[idB]; !ok || t2.Name != "" {
		t.Fatalf("a tab tmux named itself must be noted without a name, got %+v (%v)", t2, ok)
	}

	// The crash: tmux and its agents gone, one claude outside tmux still up. A
	// Remember now sees no tab at all and must keep what it knew.
	tm.run("kill-server")
	register(t, home, "2", strconv.Itoa(os.Getpid()), idB)
	if err := r.Remember(); err != nil {
		t.Fatal(err)
	}
	opened, err := r.Restore([]string{idA})
	if err != nil || len(opened) != 1 {
		t.Fatalf("restore: %+v %v", opened, err)
	}
	w := findWindow(t, tm, "fifa crash")
	if got, _ := tm.run("show-options", "-w", "-v", "-t", w, folderOption); strings.TrimSpace(got) != nested {
		t.Fatalf("reopened in folder %q, want %q", strings.TrimSpace(got), nested)
	}
	if folders, _ := tm.Folders(); !reflect.DeepEqual(folders, []string{"movvia", nested}) {
		t.Fatalf("folders rebuilt as %q", folders)
	}
}

func mustAdd(t *testing.T, tm Tmux, name string) string {
	t.Helper()
	if err := tm.AddFolder(name); err != nil {
		t.Fatal(err)
	}
	return name
}

// register writes a ~/.claude/sessions entry for a live pid, as Claude Code does.
func register(t *testing.T, home, file, pid, sessionID string) {
	t.Helper()
	n, _ := strconv.Atoi(pid)
	reg := `{"pid":` + pid + `,"sessionId":"` + sessionID + `","procStart":"` + procStarts([]int{n})[n] + `"}`
	os.WriteFile(filepath.Join(home, "sessions", file+".json"), []byte(reg), 0o600)
}
