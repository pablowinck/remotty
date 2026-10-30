package uploads

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A private tmux whose shells see home as $HOME, like the user's tmux sees theirs.
// Not t.TempDir() for the socket: macOS's long $TMPDIR passes the socket path limit.
func newFindTmux(t *testing.T, home string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "rf")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "tmux.sock")
	t.Cleanup(func() {
		exec.Command("tmux", "-S", socket, "kill-server").Run()
		os.RemoveAll(dir)
	})
	cmd := exec.Command("tmux", "-S", socket, "-f", "/dev/null", "new-session", "-d", "sleep 600")
	cmd.Env = append(os.Environ(), "HOME="+home)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("tmux: %v: %s", err, out)
	}
	return socket
}

func bigFile(t *testing.T, path string, size int64) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o700)
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, size); err != nil {
		t.Fatal(err)
	}
}

func TestFindMatchesNameAndExactSizeOutsideLibraryAndHiddenFolders(t *testing.T) {
	home, _ := filepath.EvalSymlinks(t.TempDir())
	size := int64(MaxBytes + 1)
	want := filepath.Join(home, "Downloads", "pasta x", "v (1).mov")
	bigFile(t, want, size)
	for _, skipped := range []string{"Library", ".cache", filepath.Join("app", "node_modules")} {
		bigFile(t, filepath.Join(home, skipped, "escondido.mov"), size)
	}
	bigFile(t, filepath.Join(home, "Desktop", "outro.mov"), size)   // same size, other name
	bigFile(t, filepath.Join(home, "Desktop", "v (1).mov"), size+1) // same name, other size
	mux := http.NewServeMux()
	FindRoute(mux, func(h http.HandlerFunc) http.HandlerFunc { return h }, newFindTmux(t, home))

	get := func(name string, size int64) (int, string) {
		q := url.Values{"name": {name}, "size": {strconv.FormatInt(size, 10)}}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/uploads/find?"+q.Encode(), nil))
		return w.Code, w.Body.String()
	}
	if code, body := get("v (1).mov", size); code != http.StatusOK || !strings.Contains(body, `"path":"`+want+`"`) {
		t.Errorf("found: %d %s, want 200 with %s", code, body, want)
	}
	if code, body := get("nao-existe.mov", size); code != http.StatusNotFound {
		t.Errorf("missing file: %d %s, want 404", code, body)
	}
	if code, body := get("escondido.mov", size); code != http.StatusNotFound {
		t.Errorf("file only in Library, hidden folders and node_modules: %d %s, want 404", code, body)
	}
	if code, _ := get("v (1).mov", MaxBytes); code != http.StatusBadRequest {
		t.Errorf("a file small enough to upload: %d, want 400", code)
	}
	if code, _ := get("v (1).mov", -1); code != http.StatusBadRequest {
		t.Errorf("negative size: %d, want 400", code)
	}
}
