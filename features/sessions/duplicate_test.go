package sessions

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func capture(tm Tmux, id string) string {
	out, _ := tm.run("capture-pane", "-p", "-J", "-t", id)
	return out
}

// The copy reruns the foreground command with its exact arguments (spaces and
// quotes included), in the same directory and folder, right after the original.
func TestDuplicateRerunsTheForegroundCommandInTheSameDirAndFolder(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	tm := newTestTmux(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir()) // macOS: /var is a link to /private/var
	tm.AddFolder("billing")
	id, _ := tm.run("new-window", "-d", "-P", "-F", "#{window_id}", "-t", tm.sessionTarget(), "-n", "agente", "-c", dir)
	id = strings.TrimSpace(id)
	tm.SetFolder(id, "billing")
	tm.Create("depois")
	cmd := `sh -c 'echo "args:$*:$((3*5)):$(pwd)"; sleep 300' x 'a b' "it's"`
	exec.Command("tmux", "-S", tm.Socket, "send-keys", "-t", id, "-l", cmd+"\r").Run()
	waitFor(t, "the original to run", func() bool { return strings.Contains(capture(tm, id), "args:a b it's:15") })

	dup, err := tm.Duplicate(id)
	if err != nil {
		t.Fatalf("duplicate: %v", err)
	}
	waitFor(t, "the copy to run", func() bool { return strings.Contains(capture(tm, dup), "args:a b it's:15:"+dir) })
	windows, _ := tm.List()
	var names []string
	for _, w := range windows {
		names = append(names, w.Name)
		if w.ID == dup && w.Folder != "billing" {
			t.Errorf("copy is in folder %q, want billing", w.Folder)
		}
	}
	if got := strings.Join(names[1:], ","); got != "agente,agente,depois" {
		t.Errorf("order %s, want the copy right after the original", got)
	}
}

// At its prompt a window duplicates into a plain shell in the same directory.
func TestDuplicateOfAnIdleShellIsAShellInTheSameDir(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	tm := newTestTmux(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir()) // macOS: /var is a link to /private/var
	id, _ := tm.run("new-window", "-d", "-P", "-F", "#{window_id}", "-t", tm.sessionTarget(), "-c", dir)
	id = strings.TrimSpace(id)
	// Until the shell answers, the pane may not have reached its directory yet.
	exec.Command("tmux", "-S", tm.Socket, "send-keys", "-t", id, "-l", "echo pronto-$((1+1))\r").Run()
	waitFor(t, "the original shell", func() bool { return strings.Contains(capture(tm, id), "pronto-2") })
	dup, err := tm.Duplicate(id)
	if err != nil {
		t.Fatalf("duplicate: %v", err)
	}
	exec.Command("tmux", "-S", tm.Socket, "send-keys", "-t", dup, "-l", `echo "em:$(pwd):$((6*7))"`+"\r").Run()
	waitFor(t, "the copy's shell", func() bool { return strings.Contains(capture(tm, dup), "em:"+dir+":42") })
	if _, err := tm.Duplicate("@999"); err != ErrNoWindow {
		t.Errorf("Duplicate(missing) = %v, want ErrNoWindow", err)
	}
}
