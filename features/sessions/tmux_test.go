package sessions

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// newTestTmux runs against a private tmux server so it never touches the user's sessions.
func newTestTmux(t *testing.T) Tmux {
	t.Helper()
	tm := Tmux{Socket: filepath.Join(t.TempDir(), "tmux.sock"), Session: "main"}
	t.Cleanup(func() { exec.Command("tmux", "-S", tm.Socket, "kill-server").Run() })
	if err := tm.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	return tm
}

func TestEnsureIsIdempotent(t *testing.T) {
	tm := newTestTmux(t)
	if err := tm.Ensure(); err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	w, err := tm.List()
	if err != nil || len(w) != 1 {
		t.Fatalf("want 1 window after two ensures, got %d (%v)", len(w), err)
	}
}

func TestCreateRenameClose(t *testing.T) {
	tm := newTestTmux(t)
	id, err := tm.Create("agente-1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !windowIDPattern.MatchString(id) {
		t.Fatalf("create returned %q, not a window id", id)
	}
	if err := tm.Rename(id, "revisor"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if name := nameOf(t, tm, id); name != "revisor" {
		t.Fatalf("after rename got name %q", name)
	}
	if err := tm.Close(id); err != nil {
		t.Fatalf("close: %v", err)
	}
	if name := nameOf(t, tm, id); name != "" {
		t.Fatalf("window %s still listed after close", id)
	}
}

func nameOf(t *testing.T, tm Tmux, id string) string {
	t.Helper()
	windows, err := tm.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, w := range windows {
		if w.ID == id {
			return w.Name
		}
	}
	return ""
}

// Ids reach tmux as -t targets, so anything but "@N" could address another
// session or inject a tmux command separator.
func TestRejectsBadWindowIDs(t *testing.T) {
	tm := Tmux{Socket: "unused", Session: "main"}
	for _, id := range []string{"", "main", "@", "@1;kill-server", "=main:0", "@1 ", "%1"} {
		if err := tm.Close(id); err != ErrBadWindowID {
			t.Errorf("Close(%q) = %v, want ErrBadWindowID", id, err)
		}
		if _, err := tm.AttachCommand(id); err != ErrBadWindowID {
			t.Errorf("AttachCommand(%q) = %v, want ErrBadWindowID", id, err)
		}
	}
}

func TestRejectsBadNames(t *testing.T) {
	tm := newTestTmux(t) // the legitimate name below really creates a window
	for _, name := range []string{"esc\x1b[31m", "nl\n", strings.Repeat("x", 65)} {
		if _, err := tm.Create(name); err != ErrBadName {
			t.Errorf("Create(%q) = %v, want ErrBadName", name, err)
		}
	}
	if _, err := tm.Create("nome com espaço e acento ç"); err == ErrBadName {
		t.Error("rejected a legitimate name")
	}
}

func TestParseWindows(t *testing.T) {
	out := "@1\t1\t1\t0\t0\t0\tbash\n@7\t2\t0\t1\t1\t1\tnome\tcom tab\n"
	got := parseWindows(out)
	if len(got) != 2 {
		t.Fatalf("want 2 windows, got %d", len(got))
	}
	if !got[0].Active || got[0].Bell {
		t.Errorf("window 1 flags wrong: %+v", got[0])
	}
	if got[1].ID != "@7" || !got[1].Bell || !got[1].Silence || got[1].Name != "nome\tcom tab" {
		t.Errorf("window 2 parsed wrong: %+v", got[1])
	}
}

// A tab reconnecting to a window that died must not land in another window:
// its keystrokes would reach a different agent.
func TestAttachToMissingWindowIsRefused(t *testing.T) {
	tm := newTestTmux(t)
	if _, err := tm.AttachCommand("@999"); err != ErrNoWindow {
		t.Fatalf("AttachCommand(missing) = %v, want ErrNoWindow", err)
	}
	windows, _ := tm.List()
	if _, err := tm.AttachCommand(windows[0].ID); err != nil {
		t.Fatalf("anchor: attaching to a live window failed: %v", err)
	}
}

// The session can vanish under a running server (kill-server over ssh, the last
// window exiting). The API must bring it back instead of failing forever.
func TestListAndCreateRecoverAfterTheSessionDies(t *testing.T) {
	tm := newTestTmux(t)
	exec.Command("tmux", "-S", tm.Socket, "kill-server").Run()
	if _, err := tm.List(); err != nil {
		t.Fatalf("List after kill-server: %v", err)
	}
	exec.Command("tmux", "-S", tm.Socket, "kill-server").Run()
	if _, err := tm.Create("depois"); err != nil {
		t.Fatalf("Create after kill-server: %v", err)
	}
}

func TestRejectsNamesTmuxWouldMisread(t *testing.T) {
	tm := newTestTmux(t)
	for _, name := range []string{"-f", "--help", "fim;", `fim\;`} {
		if _, err := tm.Create(name); err != ErrBadName {
			t.Errorf("Create(%q) = %v, want ErrBadName", name, err)
		}
	}
	if _, err := tm.Create("a-b;c"); err != nil {
		t.Errorf("anchor: an inner dash or semicolon is fine: %v", err)
	}
}

func TestMovePutsAWindowBeforeOrAfterAnotherAndRenumbers(t *testing.T) {
	tm := newTestTmux(t)
	for _, n := range []string{"b", "c", "d"} {
		if _, err := tm.Create(n); err != nil {
			t.Fatal(err)
		}
	}
	tm.Rename(mustList(t, tm)[0].ID, "a")
	id := func(name string) string {
		for _, w := range mustList(t, tm) {
			if w.Name == name {
				return w.ID
			}
		}
		t.Fatalf("no window %q", name)
		return ""
	}
	// Names in index order, with indexes relative to the first: the base index
	// comes from the user's tmux.conf, the gaps would come from Move.
	order := func() string {
		var s []string
		list := mustList(t, tm)
		for _, w := range list {
			s = append(s, strconv.Itoa(w.Index-list[0].Index)+w.Name)
		}
		return strings.Join(s, " ")
	}
	if err := tm.Move(id("a"), id("d"), true); err != nil { // first to last
		t.Fatal(err)
	}
	if got := order(); got != "0b 1c 2d 3a" {
		t.Fatalf("after moving a after d: %q, want %q", got, "0b 1c 2d 3a")
	}
	if err := tm.Move(id("c"), id("b"), false); err != nil { // row 2 to row 1
		t.Fatal(err)
	}
	if got := order(); got != "0c 1b 2d 3a" {
		t.Fatalf("after moving c before b: %q, want %q", got, "0c 1b 2d 3a")
	}
	for _, bad := range [][2]string{{"@1;kill-server", id("a")}, {id("a"), "main"}} {
		if err := tm.Move(bad[0], bad[1], true); err != ErrBadWindowID {
			t.Errorf("Move(%q, %q) = %v, want ErrBadWindowID", bad[0], bad[1], err)
		}
	}
	if err := tm.Move(id("a"), "@999", true); err != ErrNoWindow {
		t.Errorf("Move to a missing window = %v, want ErrNoWindow", err)
	}
}

func mustList(t *testing.T, tm Tmux) []Window {
	t.Helper()
	w, err := tm.List()
	if err != nil {
		t.Fatal(err)
	}
	return w
}

// /tmp is wiped at boot, and with -S tmux does not create the socket's
// directory: the default /tmp/tmux-UID/default is then unusable until
// something makes the directory. After a reboot that was every agent gone
// and no way to create a new one from the page.
func TestEnsureCreatesTheSocketDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tmux-1000") // does not exist yet
	tm := Tmux{Socket: filepath.Join(dir, "default"), Session: "main"}
	t.Cleanup(func() { exec.Command("tmux", "-S", tm.Socket, "kill-server").Run() })
	if _, err := tm.Create("depois-do-boot"); err != nil {
		t.Fatalf("Create with a missing socket directory: %v", err)
	}
	st, err := os.Stat(dir)
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("socket dir %v (%v), want 0700: tmux refuses a directory others can read", st, err)
	}
}
