package sessions

import (
	"strings"
	"testing"
	"time"
)

func hasWindow(t *testing.T, tm Tmux, id string) bool {
	t.Helper()
	windows, err := tm.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, w := range windows {
		if w.ID == id {
			return true
		}
	}
	return false
}

// alive reports whether window id still exists anywhere on the server.
func alive(tm Tmux, id string) bool {
	out, _ := tm.run("display-message", "-p", "-t", id, "#{window_id}")
	return strings.TrimSpace(out) == id
}

// ⌘W hides the window without killing what runs in it; ⌘Z brings the same
// window (same id, same process) back to the list.
func TestCloseUndoableHidesAndReopenBringsItBack(t *testing.T) {
	tm := newTestTmux(t)
	id, err := tm.Create("agente")
	if err != nil {
		t.Fatal(err)
	}
	if err := tm.CloseUndoable(id); err != nil {
		t.Fatalf("close: %v", err)
	}
	if hasWindow(t, tm, id) {
		t.Fatal("a closed window is still listed")
	}
	if !alive(tm, id) {
		t.Fatal("closing killed the window; it must stay alive until the grace ends")
	}
	back, err := tm.ReopenLast()
	if err != nil || back != id {
		t.Fatalf("reopen = %q, %v; want %q", back, err, id)
	}
	if !hasWindow(t, tm, id) {
		t.Fatal("the reopened window is not listed")
	}
	if _, err := tm.ReopenLast(); err != ErrNothingToReopen {
		t.Fatalf("second reopen = %v, want ErrNothingToReopen", err)
	}
}

func TestReopenableCountsHiddenWindowsNotThePlaceholder(t *testing.T) {
	tm := newTestTmux(t)
	if n := tm.Reopenable(); n != 0 {
		t.Fatalf("nothing closed yet, got %d", n)
	}
	a, _ := tm.Create("a")
	b, _ := tm.Create("b")
	tm.CloseUndoable(a)
	tm.CloseUndoable(b)
	if n := tm.Reopenable(); n != 2 {
		t.Fatalf("two closed, got %d", n) // the hidden session's placeholder window must not count
	}
	tm.ReopenLast()
	if n := tm.Reopenable(); n != 1 {
		t.Fatalf("one reopened, got %d", n)
	}
	// The placeholder between two closed windows: its blank stamp is a line of
	// its own there, not trimmed away, and must not count.
	c, _ := tm.Create("c")
	tm.CloseUndoable(c)
	hidden := "=" + tm.closedSession() + ":"
	tm.run("move-window", "-s", hidden+"placeholder", "-t", hidden+"50")
	tm.run("move-window", "-s", c, "-t", hidden+"99")
	if n := tm.Reopenable(); n != 2 {
		t.Fatalf("placeholder between two closed windows, got %d", n)
	}
}

func TestReopenTakesTheLastClosedFirst(t *testing.T) {
	tm := newTestTmux(t)
	a, _ := tm.Create("a")
	b, _ := tm.Create("b")
	tm.CloseUndoable(a)
	tm.CloseUndoable(b)
	if got, _ := tm.ReopenLast(); got != b {
		t.Fatalf("first reopen = %q, want the last closed %q", got, b)
	}
	if got, _ := tm.ReopenLast(); got != a {
		t.Fatalf("second reopen = %q, want %q", got, a)
	}
}

// After the grace period the window is really gone; reopening in time disarms
// the timer, so a window brought back is never killed behind the user's back.
func TestGraceEndsTheWindowUnlessReopened(t *testing.T) {
	old := CloseGrace
	CloseGrace = time.Second
	t.Cleanup(func() { CloseGrace = old })
	tm := newTestTmux(t)
	gone, _ := tm.Create("vai")
	kept, _ := tm.Create("fica")

	tm.CloseUndoable(kept)
	if got, _ := tm.ReopenLast(); got != kept {
		t.Fatalf("reopen = %q, want %q", got, kept)
	}
	tm.CloseUndoable(gone)

	deadline := time.Now().Add(5 * time.Second)
	for alive(tm, gone) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if alive(tm, gone) {
		t.Fatal("a closed window outlived its grace period")
	}
	if !alive(tm, kept) || !hasWindow(t, tm, kept) {
		t.Fatal("a reopened window was killed by its old timer") // anchor: the timer did run, above
	}
	if _, err := tm.ReopenLast(); err != ErrNothingToReopen {
		t.Fatalf("reopen after the grace = %v, want ErrNothingToReopen", err)
	}
}

func TestCloseUndoableRejectsBadAndMissingIDs(t *testing.T) {
	tm := newTestTmux(t)
	if err := tm.CloseUndoable("@1;x"); err != ErrBadWindowID {
		t.Errorf("bad id = %v", err)
	}
	if err := tm.CloseUndoable("@999"); err != ErrNoWindow {
		t.Errorf("missing id = %v", err)
	}
}
