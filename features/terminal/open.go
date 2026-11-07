package terminal

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/pablowinck/remotty/features/access"
)

// ⌘-click on a link, with the page open on this machine, opens it in the
// default browser instead of the one showing the page (a Chrome app). A
// phone's click keeps opening on the phone: the page only asks from loopback.
func OpenRoute(mux *http.ServeMux, wrap func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("POST /api/open", wrap(handleOpen))
}

// openURL is swapped in tests; REMOTTY_OPENER lets the e2e host open nothing.
// It waits for the opener: open(1) and xdg-open hand the URL over and exit, and
// one that fails (xdg-open without a desktop, as under WSL) must answer an
// error, so the page opens the link itself instead.
var openURL = func(u string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, opener(), u).Run()
}

func opener() string {
	if cmd := os.Getenv("REMOTTY_OPENER"); cmd != "" {
		return cmd
	}
	if runtime.GOOS == "darwin" {
		return "open"
	}
	return "xdg-open"
}

func handleOpen(w http.ResponseWriter, r *http.Request) {
	if !fromThisMachine(r) {
		http.Error(w, "links open on the host only from the host", http.StatusForbidden)
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil || !isWebURL(body.URL) {
		http.Error(w, `want {"url":"http(s)://..."}`, http.StatusBadRequest)
		return
	}
	if err := openURL(body.URL); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Both ends local: tailscale serve also connects from loopback, but with the
// tailnet name as Host.
func fromThisMachine(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	peer, _, _ := net.SplitHostPort(r.RemoteAddr)
	return access.IsLoopback(host) && access.IsLoopback(peer)
}

// The text comes from programs in the terminal: nothing but a web address.
func isWebURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}
