package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/pablowinck/remotty/features/access"
	"github.com/pablowinck/remotty/features/sessions"
	"github.com/pablowinck/remotty/features/terminal"
	"github.com/pablowinck/remotty/features/uploads"
	"github.com/pablowinck/remotty/web"
)

// serveFlags is everything `remotty serve` (and `remotty install`) accepts.
type serveFlags struct {
	addr, origins, socket, session, restore string
}

func parseServeFlags(args []string) (serveFlags, error) {
	var f serveFlags
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.StringVar(&f.addr, "addr", "127.0.0.1:7681", "listen `address`; keep it on loopback and publish it with tailscale serve")
	fs.StringVar(&f.origins, "origin", "", "comma-separated `origins` the UI is served from (default: this machine's tailnet name, plus localhost)")
	fs.StringVar(&f.socket, "tmux-socket", "", "tmux socket path (default: tmux's own default socket)")
	fs.StringVar(&f.session, "session", "main", "tmux session whose windows become tabs")
	fs.StringVar(&f.restore, "restore-command", "claude --resume", "`command` the Restore button runs, plus a conversation id, for each Claude Code conversation that stopped; empty hides the button")
	return f, fs.Parse(args)
}

func serve(args []string, store access.Store) error {
	f, err := parseServeFlags(args)
	if err != nil {
		return err
	}
	warnIfExposed(f.addr)
	ln, err := net.Listen("tcp", f.addr)
	if err != nil {
		return err
	}
	allowed, err := resolveOrigins(f.origins, ln.Addr().(*net.TCPAddr).Port)
	if err != nil {
		return err
	}
	tm := sessions.Tmux{Socket: tmuxSocket(f.socket), Session: f.session}
	if err := tm.Ensure(); err != nil {
		return fmt.Errorf("tmux: %w", err)
	}
	saveURL(store.Dir, allowed[0])
	uploadDir := uploads.Dir(filepath.Join(store.Dir, "uploads"))
	guard := access.Guard{Store: store, Origins: allowed}
	var restorer *sessions.Restorer
	if f.restore != "" {
		home, _ := os.UserHomeDir()
		restorer = sessions.NewRestorer(tm, filepath.Join(home, ".claude"), f.restore)
	}
	srv := &http.Server{Handler: guard.Wrap(routes(guard, tm, uploadDir, restorer)), ReadHeaderTimeout: 10 * time.Second}
	// Scripts and tests read this line to learn the port when -addr ends in :0.
	fmt.Printf("remotty listening on http://%s (origins: %s)\n", ln.Addr(), strings.Join(allowed, ", "))
	fmt.Printf("Open %s on your device, then run `remotty pair` here.\n", allowed[0])
	return runUntilSignal(srv, ln)
}

func warnIfExposed(addr string) {
	if host, _, err := net.SplitHostPort(addr); err == nil && !access.IsLoopback(host) {
		log.Printf("warning: listening on %s, not loopback. Anyone who can reach it only needs a pairing code.", host)
	}
}

// resolveOrigins turns -origin (or the detected default) into the exact list
// the guard enforces.
func resolveOrigins(flagValue string, port int) ([]string, error) {
	if flagValue == "" {
		flagValue = detectOrigins()
	}
	allowed := originList(flagValue, port)
	if len(allowed) == 0 {
		return nil, fmt.Errorf("-origin %q names no origin", flagValue)
	}
	return allowed, nil
}

func routes(guard access.Guard, tm sessions.Tmux, uploadDir uploads.Dir, restorer *sessions.Restorer) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /", web.Handler())
	mux.HandleFunc("POST /api/pair", guard.HandlePair)
	mux.HandleFunc("GET /api/me", guard.RequireDevice(access.HandleMe))
	tm.Routes(mux, guard.RequireDevice, attach(guard.OriginHosts()))
	uploadDir.Routes(mux, guard.RequireDevice)
	if restorer != nil {
		restorer.Routes(mux, guard.RequireDevice)
	}
	return mux
}

// attach upgrades to a WebSocket and runs argv in a PTY behind it. The guard
// already checked Origin; the library checks it again against the same list,
// so the terminal never depends on a single layer.
func attach(originHosts []string) func(http.ResponseWriter, *http.Request, []string) {
	opts := &websocket.AcceptOptions{OriginPatterns: originHosts}
	return func(w http.ResponseWriter, r *http.Request, argv []string) {
		conn, err := websocket.Accept(w, r, opts)
		if err != nil {
			return
		}
		size := terminal.ParseSize(r.URL.Query().Get("cols"), r.URL.Query().Get("rows"))
		terminal.Serve(r.Context(), conn, argv, terminalEnv(), size)
	}
}

// terminalEnv gives tmux a sane terminal type; everything else is inherited.
func terminalEnv() []string {
	env := []string{"TERM=xterm-256color", "COLORTERM=truecolor"}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "TERM=") && !strings.HasPrefix(kv, "COLORTERM=") && !strings.HasPrefix(kv, "TMUX=") {
			env = append(env, kv)
		}
	}
	return env
}

// originList parses -origin. A ":0" port means "the port we actually bound",
// which lets scripts ask for a random port and still name the origin up front.
func originList(flagValue string, port int) []string {
	if flagValue == "" {
		flagValue = "http://localhost:0"
	}
	var list []string
	for _, o := range strings.Split(flagValue, ",") {
		o = strings.TrimRight(strings.TrimSpace(o), "/")
		if strings.HasSuffix(o, ":0") {
			o = fmt.Sprintf("%s:%d", strings.TrimSuffix(o, ":0"), port)
		}
		if o != "" {
			list = append(list, o)
		}
	}
	return list
}

// tmuxSocket resolves tmux's default socket so the browser sees the same
// windows as a plain `tmux attach` over ssh or mosh.
func tmuxSocket(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	dir := os.Getenv("TMUX_TMPDIR")
	if dir == "" {
		dir = "/tmp"
	}
	return fmt.Sprintf("%s/tmux-%d/default", dir, os.Getuid())
}

func runUntilSignal(srv *http.Server, ln net.Listener) error {
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errc:
		return err
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(ctx)
	}
}
