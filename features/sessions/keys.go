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
