package sessions

import (
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// Undo keeps a closed window alive, out of sight, so ⌘Z can bring it back.
// Personal preference (local branch), not upstream behaviour.
//
// A closed window moves to a hidden session; a tmux run-shell timer kills it
// after the grace period. The timer lives in the tmux server, so a remotty
// restart never leaves a "closed" agent running forever.
const closedSuffix = "-closed"

// CloseGrace is how long a closed window can still be reopened.
var CloseGrace = 5 * time.Minute

var ErrNothingToReopen = errors.New("nothing to reopen")

func (t Tmux) closedSession() string { return t.Session + closedSuffix }

// CloseUndoable hides window id instead of killing it, and arms its kill timer.
func (t Tmux) CloseUndoable(id string) error {
	if !windowIDPattern.MatchString(id) {
		return ErrBadWindowID
	}
	if out, _ := t.run("display-message", "-p", "-t", id, "#{window_id}"); strings.TrimSpace(out) != id {
		return ErrNoWindow
	}
	hidden := t.closedSession()
	if _, err := t.run("has-session", "-t", "="+hidden); err != nil {
		// A placeholder window keeps the hidden session alive when it holds no closed agent.
		if _, err := t.run("new-session", "-d", "-s", hidden, "-n", "placeholder", "sleep 2147483647"); err != nil {
			return err
		}
	}
	stamp := fmt.Sprint(time.Now().UnixNano())
	// The tmux server's own PATH may lack Homebrew (launchd), so name tmux in full.
	bin, err := exec.LookPath("tmux")
	if err != nil {
		bin = "tmux"
	}
	// The timer kills only if the window still carries this close's stamp:
	// reopened (stamp cleared) or closed again (newer stamp), it leaves it alone.
	kill := fmt.Sprintf("sleep %d; [ \"$('%s' -S '%s' show -wqv -t %s @closed)\" = %s ] && '%s' -S '%s' kill-window -t %s",
		int(CloseGrace.Seconds()), bin, t.Socket, id, stamp, bin, t.Socket, id)
	_, err = t.run("set-option", "-w", "-t", id, "@closed", stamp,
		";", "move-window", "-d", "-s", id, "-t", "="+hidden+":",
		";", "run-shell", "-b", kill)
	return err
}

// ReopenLast moves the most recently closed window back to the end of the
// session and returns its id. Reopening clears @closed, which disarms its timer.
func (t Tmux) ReopenLast() (string, error) {
	out, err := t.run("list-windows", "-t", "="+t.closedSession(), "-F", "#{window_id}\t#{@closed}")
	if err != nil {
		return "", ErrNothingToReopen
	}
	id, latest := "", ""
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.SplitN(line, "\t", 2)
		if len(f) == 2 && f[1] != "" && (len(f[1]) > len(latest) || (len(f[1]) == len(latest) && f[1] > latest)) {
			id, latest = f[0], f[1]
		}
	}
	if id == "" {
		return "", ErrNothingToReopen
	}
	// inSession: closing the last agent ended the session; it comes back first.
	_, err = t.inSession("set-option", "-w", "-u", "-t", id, "@closed",
		";", "move-window", "-d", "-s", id, "-t", "="+t.Session+":")
	return id, err
}

// UndoRoutes registers the undoable close and the reopen next to the window API.
func (t Tmux) UndoRoutes(mux *http.ServeMux, wrap func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("POST /api/windows/{id}/close", wrap(func(w http.ResponseWriter, r *http.Request) {
		if respond(w, t.CloseUndoable(r.PathValue("id"))) {
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	mux.HandleFunc("POST /api/windows/reopen", wrap(func(w http.ResponseWriter, r *http.Request) {
		id, err := t.ReopenLast()
		if errors.Is(err, ErrNothingToReopen) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if respond(w, err) {
			writeJSON(w, http.StatusOK, map[string]string{"id": id})
		}
	}))
}
