package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/pablowinck/remotty/features/mcp"
	"github.com/pablowinck/remotty/features/sessions"
)

// runMCP serves the MCP tools on stdin/stdout. It talks to tmux directly, as
// the user who owns the socket, so it needs neither the server nor a pairing.
func runMCP(args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	socket := fs.String("tmux-socket", "", "tmux socket path (default: tmux's own default socket, as serve)")
	session := fs.String("session", "main", "tmux session whose windows the tools drive, as serve")
	if err := fs.Parse(args); err != nil {
		return err
	}
	tm := sessions.Tmux{Socket: tmuxSocket(*socket), Session: *session}
	if err := tm.Ensure(); err != nil {
		return fmt.Errorf("tmux: %w", err)
	}
	return mcp.Serve(os.Stdin, os.Stdout, mcp.Toolbox{Tmux: tm, Self: tm.WindowOf(os.Getenv("TMUX_PANE"))})
}
