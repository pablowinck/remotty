package terminal

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"

	"github.com/pablowinck/remotty/features/access"
)

// Local: ⌘-click on a link, with the page open on this machine, opens it in the
// default browser (Arc) instead of the one showing the page (a Chrome app). A
// phone's click keeps opening on the phone: the page only asks from loopback.
func OpenRoute(mux *http.ServeMux, wrap func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("POST /api/open", wrap(handleOpen))
}

// openURL is swapped in tests; REMOTTY_OPENER lets the e2e host open nothing.
var openURL = func(u string) error {
	cmd := exec.Command(opener(), u)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
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
