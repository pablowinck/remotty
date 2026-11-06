package sessions

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// What an orchestrating agent does to another window: type into it, press keys
// on it, read what it shows. Everything goes through tmux, so it works for any
// program in the window, Claude Code's question menus included.

// namedKeys are the tmux key names send_keys accepts. A closed list: anything
// else would let a caller hand tmux a target, a flag or a command separator.
var namedKeys = map[string]bool{
	"Enter": true, "Escape": true, "Tab": true, "BTab": true, "Space": true, "BSpace": true,
	"Up": true, "Down": true, "Left": true, "Right": true, "Home": true, "End": true,
	"PageUp": true, "PageDown": true, "C-c": true, "C-d": true, "C-u": true, "C-l": true,
}

var singleKey = regexp.MustCompile(`^[a-zA-Z0-9]$`) // a digit picks a numbered option

// EnterDelay separates pasted text from the Enter that submits it. Sent in the
// same burst, the Enter was lost (zsh) or taken as part of the paste.
// shortcut: a fixed pause, not a signal that the program took the paste; raise
// it if a slow program still drops the Enter.
var EnterDelay = 300 * time.Millisecond

const maxScrollback = 2000

// SendText types text into window id, as one paste, then presses Enter if
// enter is set. A paste, not send-keys: send-keys -l reads its argument as tmux
// command syntax, and a trailing ";" vanished as a command separator.
func (t Tmux) SendText(id, text string, enter bool) error {
	if err := t.checkWindow(id); err != nil {
		return err
	}
	if text != "" {
		if err := t.paste(id, text); err != nil {
			return err
		}
		time.Sleep(EnterDelay)
	}
	if !enter {
		return nil
	}
	_, err := t.run("send-keys", "-t", id, "Enter")
	return err
}

// paste loads text through stdin, so no byte of it is parsed by tmux, and
// pastes it bracketed when the program asked for that (-p), as a terminal does.
func (t Tmux) paste(id, text string) error {
	buffer := "remotty-" + strings.TrimPrefix(id, "@")
	cmd := exec.Command("tmux", "-S", t.Socket, "load-buffer", "-b", buffer, "-")
	cmd.Stdin = strings.NewReader(text)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux load-buffer: %w: %s", err, strings.TrimSpace(string(out)))
	}
	_, err := t.run("paste-buffer", "-p", "-d", "-b", buffer, "-t", id)
	return err
}

// SendKeys presses keys in order: tmux key names (Enter, Up, Escape...) or one
// letter or digit each.
func (t Tmux) SendKeys(id string, keys []string) error {
	if err := t.checkWindow(id); err != nil {
		return err
	}
	if len(keys) == 0 {
		return ErrBadKey
	}
	for _, k := range keys {
		if !namedKeys[k] && !singleKey.MatchString(k) {
			return fmt.Errorf("%w: %q", ErrBadKey, k)
		}
	}
	_, err := t.run(append([]string{"send-keys", "-t", id}, keys...)...)
	return err
}

// Capture returns what window id shows, plus up to scrollback lines above it.
func (t Tmux) Capture(id string, scrollback int) (string, error) {
	if err := t.checkWindow(id); err != nil {
		return "", err
	}
	args := []string{"capture-pane", "-p", "-J", "-t", id}
	if scrollback > 0 {
		args = append(args, "-S", "-"+strconv.Itoa(min(scrollback, maxScrollback)))
	}
	return t.run(args...)
}

// WaitPoll is how often Wait looks at the screen.
var WaitPoll = 250 * time.Millisecond

// Wait returns once window id is done: when a line holding until shows up, or,
// with until empty, when the screen has not changed for quiet. A working agent
// keeps its screen moving (Claude Code's spinner and timer tick every second),
// so a still screen means it is at its prompt or asking something. ready is
// false when timeout came first. screen is what it showed last.
// shortcut: a still screen is a guess, not a signal; a program that sits silent
// while it works (a long command with no output) looks done after quiet.
func (t Tmux) Wait(id, until string, quiet, timeout time.Duration) (screen string, ready bool, err error) {
	deadline := time.Now().Add(timeout)
	stillSince := time.Now()
	var before map[string]bool
	for {
		now, err := t.Capture(id, 0)
		if err != nil {
			return screen, false, err
		}
		if before == nil {
			before = lineSet(now)
		}
		if now != screen {
			screen, stillSince = now, time.Now()
		}
		if until != "" && hasNewLine(screen, until, before) || until == "" && time.Since(stillSince) >= quiet {
			return screen, true, nil
		}
		if time.Now().After(deadline) {
			return screen, false, nil
		}
		time.Sleep(WaitPoll)
	}
}

// hasNewLine reports whether screen has a line holding until that was not on
// it when the wait began. The prompt that asked for the marker usually names it
// ("then write DONE=<x>"), and matching that echo returned before the answer.
func hasNewLine(screen, until string, before map[string]bool) bool {
	for _, l := range strings.Split(screen, "\n") {
		if strings.Contains(l, until) && !before[l] {
			return true
		}
	}
	return false
}

func lineSet(screen string) map[string]bool {
	set := map[string]bool{}
	for _, l := range strings.Split(screen, "\n") {
		set[l] = true
	}
	return set
}

var paneIDPattern = regexp.MustCompile(`^%[0-9]+$`)

// WindowOf returns the window holding tmux pane pane ($TMUX_PANE, "%3"), or ""
// when it is not a pane of this server.
func (t Tmux) WindowOf(pane string) string {
	if !paneIDPattern.MatchString(pane) {
		return ""
	}
	out, _ := t.run("display-message", "-p", "-t", pane, "#{window_id}")
	return strings.TrimSpace(out)
}

func (t Tmux) checkWindow(id string) error {
	if !windowIDPattern.MatchString(id) {
		return ErrBadWindowID
	}
	if !t.hasWindow(id) {
		return ErrNoWindow
	}
	return nil
}
