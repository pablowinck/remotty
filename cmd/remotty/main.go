// Command remotty serves your tmux windows to a browser: one tab per agent,
// reachable from a tablet over your tailnet.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/pablowinck/remotty/features/access"
)

const usage = `remotty — your tmux windows in a browser tab.

  remotty serve [flags]      run the server (see remotty serve -h)
  remotty install [flags]    run serve as a login service (systemd on Linux, launchd on macOS), restarted on crash
  remotty pair [--json]      print a one-time pairing code (valid 5 min)
  remotty devices            list paired devices (expiry moves 30 days ahead on each use)
  remotty revoke ID|--all    unpair a device, closing its open terminals
`

func main() {
	err := run(os.Args[1:], os.Stdout)
	if errors.Is(err, flag.ErrHelp) {
		return // the flag package already printed the usage
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "remotty:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(out, usage)
		return nil
	}
	store := access.Store{Dir: stateDir()}
	switch args[0] {
	case "serve":
		return serve(args[1:], store)
	case "install":
		return install(args[1:], out)
	case "pair":
		return pair(args[1:], store, out)
	case "devices":
		return devices(store, out)
	case "revoke":
		return revoke(args[1:], store, out)
	case "-h", "--help", "help":
		fmt.Fprint(out, usage)
		return nil
	}
	return fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
}

// stateDir follows XDG so tests (and multiple installs) isolate by env alone.
func stateDir() string {
	if d := os.Getenv("REMOTTY_STATE_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return filepath.Join(d, "remotty")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "remotty")
}

func pair(args []string, store access.Store, out io.Writer) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the code as JSON (for scripts and tests)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	code, err := store.NewCode()
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(out).Encode(map[string]string{"code": code})
	}
	link := pairingLink(store.Dir, code)
	if art, err := terminalQR(link); link != "" && err == nil {
		fmt.Fprint(out, "\nScan with the phone or tablet camera:\n\n", art, "\n")
	}
	fmt.Fprintf(out, "Pairing code: %s-%s  (valid 5 minutes, one use)\n", code[:5], code[5:])
	if link != "" {
		fmt.Fprintf(out, "Or open this link on the device: %s\n", link)
	}
	return nil
}

func devices(store access.Store, out io.Writer) error {
	list, err := store.Devices()
	if err != nil {
		return err
	}
	if len(list) == 0 {
		fmt.Fprintln(out, "No paired devices. Run `remotty pair` to add one.")
		return nil
	}
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tNAME\tPAIRED\tEXPIRES IF UNUSED")
	for _, d := range list {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", d.ID, d.Name, d.Created.Format("2006-01-02 15:04"), d.Expires.Format("2006-01-02"))
	}
	return w.Flush()
}

func revoke(args []string, store access.Store, out io.Writer) error {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return errors.New("usage: remotty revoke ID|--all")
	}
	id := args[0]
	if id == "--all" {
		id = ""
	}
	n, err := store.Revoke(id)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("no device with id %q", args[0])
	}
	fmt.Fprintf(out, "Revoked %d device(s). Their open terminals close within a second.\n", n)
	return nil
}
