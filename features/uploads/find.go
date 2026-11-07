package uploads

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// A file over MaxBytes dropped on the host is not copied; its own path is
// found by name and exact size. The search runs in the tmux server, beside the
// shells: macOS keeps the launchd-started remotty out of Downloads and Desktop.
func FindRoute(mux *http.ServeMux, wrap func(http.HandlerFunc) http.HandlerFunc, socket string) {
	mux.HandleFunc("GET /api/uploads/find", wrap(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		size, err := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
		if err != nil || size <= MaxBytes || name == "" {
			http.Error(w, fmt.Sprintf("want ?name=<file>&size=<bytes over %d>, got name %q size %q", MaxBytes, name, r.URL.Query().Get("size")), http.StatusBadRequest)
			return
		}
		path, err := find(r, socket, name, size)
		switch {
		case err != nil:
			http.Error(w, "could not search the host: "+err.Error(), http.StatusInternalServerError)
		case path == "":
			http.Error(w, fmt.Sprintf("%s is over %d MB and is not in your home folder", name, MaxBytes>>20), http.StatusNotFound)
		default:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"path": path})
		}
	}))
}

// Only the size, a number, reaches the shell; the name is matched here. Library,
// hidden folders and node_modules are skipped: about a second for a whole home.
func find(r *http.Request, socket, name string, size int64) (string, error) {
	script := fmt.Sprintf(`find "$HOME" \( -path "$HOME/Library" -o -name '.*' -o -name node_modules \) -prune -o -type f -size %dc -print 2>/dev/null; true`, size)
	out, err := exec.CommandContext(r.Context(), "tmux", "-S", socket, "run-shell", script).Output()
	if err != nil {
		return "", err
	}
	for _, path := range strings.Split(string(out), "\n") {
		if filepath.Base(path) == name {
			return path, nil
		}
	}
	return "", nil
}
