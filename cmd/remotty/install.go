package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// unitTemplate keeps remotty running across reboots and crashes. A user unit
// needs no root; with `loginctl enable-linger` it runs without a login too.
const unitTemplate = `[Unit]
Description=remotty: tmux windows in a browser tab
After=network-online.target

[Service]
ExecStart=%s serve %s
Restart=on-failure
RestartSec=2
# remotty may be the one that starts the tmux server, which then lives in this
# unit's cgroup. The default (control-group) kills it on every restart or
# upgrade, and with it every agent. Only the remotty process itself is stopped.
KillMode=process

[Install]
WantedBy=default.target
`

// install writes and starts a login service running `remotty serve` with the
// given serve flags: a systemd user unit on Linux, a launchd agent on macOS.
func install(args []string, out io.Writer) error {
	// Parse now, so a typo fails here and not in a crash-looping service.
	if _, err := parseServeFlags(args); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	if runtime.GOOS == "darwin" {
		return installLaunchd(exe, args, out)
	}
	return installSystemd(exe, args, out)
}

func installSystemd(exe string, args []string, out io.Writer) error {
	dir, err := unitDir()
	if err != nil {
		return err
	}
	unit := filepath.Join(dir, "remotty.service")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(unit, []byte(renderUnit(exe, args)), 0o644); err != nil {
		return err
	}
	for _, cmd := range [][]string{{"daemon-reload"}, {"enable", "--now", "remotty.service"}, {"restart", "remotty.service"}} {
		if b, err := exec.Command("systemctl", append([]string{"--user"}, cmd...)...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl --user %s: %w: %s", strings.Join(cmd, " "), err, strings.TrimSpace(string(b)))
		}
	}
	fmt.Fprintf(out, "Installed %s and started it.\n", unit)
	fmt.Fprintln(out, "It restarts on crash and starts at boot. Logs: journalctl --user -u remotty -f")
	fmt.Fprintln(out, "To keep it running while you are logged out: loginctl enable-linger")
	return nil
}

func unitDir() (string, error) {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "systemd", "user"), nil
	}
	home, err := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user"), err
}

// renderUnit quotes each argument for systemd, which splits ExecStart on spaces.
func renderUnit(exe string, args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`).Replace(a) + `"`
	}
	return fmt.Sprintf(unitTemplate, exe, strings.Join(quoted, " "))
}
