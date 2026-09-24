package main

import (
	"fmt"
	"html"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const launchdLabel = "io.github.pablowinck.remotty"

// plistTemplate is the macOS twin of unitTemplate: started at login, restarted
// on crash (KeepAlive on failure, like Restart=on-failure), and the tmux server
// it may have started survives a restart (AbandonProcessGroup, like
// KillMode=process). launchd gives a bare environment, so PATH and SHELL are
// written in: tmux windows, and Restore's `claude --resume`, inherit them.
const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
%s	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>%s</string>
		<key>SHELL</key>
		<string>%s</string>
		<key>LANG</key>
		<string>%s</string>
	</dict>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`

// installLaunchd writes a LaunchAgent and (re)loads it. No root: it lives in
// ~/Library/LaunchAgents and runs as the user, at login.
func installLaunchd(exe string, args []string, out io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, "Library", "LaunchAgents")
	plist := filepath.Join(dir, launchdLabel+".plist")
	logFile := filepath.Join(home, "Library", "Logs", "remotty.log")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	body := renderPlist(exe, args, launchdEnv(), logFile)
	if err := os.WriteFile(plist, []byte(body), 0o644); err != nil {
		return err
	}
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	exec.Command("launchctl", "bootout", domain+"/"+launchdLabel).Run() // not loaded yet is fine
	if b, err := exec.Command("launchctl", "bootstrap", domain, plist).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap %s %s: %w: %s", domain, plist, err, strings.TrimSpace(string(b)))
	}
	fmt.Fprintf(out, "Installed %s and started it.\n", plist)
	fmt.Fprintf(out, "It restarts on crash and starts at login. Logs: tail -f %s\n", logFile)
	return nil
}

// launchdEnv is PATH, SHELL and LANG as the installing shell has them.
func launchdEnv() [3]string {
	get := func(k, fallback string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return fallback
	}
	return [3]string{get("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"), get("SHELL", "/bin/zsh"), get("LANG", "en_US.UTF-8")}
}

// renderPlist escapes every value: flags such as -restore-command may hold &, < or quotes.
func renderPlist(exe string, args []string, env [3]string, logFile string) string {
	var argv strings.Builder
	for _, a := range append([]string{exe, "serve"}, args...) {
		fmt.Fprintf(&argv, "\t\t<string>%s</string>\n", html.EscapeString(a))
	}
	e := html.EscapeString
	return fmt.Sprintf(plistTemplate, launchdLabel, argv.String(), e(env[0]), e(env[1]), e(env[2]), e(logFile), e(logFile))
}
