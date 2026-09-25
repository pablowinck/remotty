package main

import (
	"fmt"
	"html"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const launchdLabel = "io.github.pablowinck.remotty"

// plistTemplate is the macOS twin of unitTemplate: started at login, restarted
// on crash (KeepAlive on failure, like Restart=on-failure), and the tmux server
// it may have started survives a restart (AbandonProcessGroup, like
// KillMode=process). launchd gives a bare environment and starts in /, so PATH,
// SHELL and the home directory are written in: tmux windows, and Restore's
// `claude --resume`, inherit them, as they do under systemd.
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
	<key>WorkingDirectory</key>
	<string>%s</string>
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
// ~/Library/LaunchAgents and runs as the user.
func installLaunchd(exe string, args []string, out io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, "Library", "LaunchAgents")
	plist := filepath.Join(dir, launchdLabel+".plist")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(plist, []byte(renderPlist(exe, args, launchdEnv(), home)), 0o644); err != nil {
		return err
	}
	domain, err := loadLaunchAgent(plist, launchctl, time.Sleep)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Installed %s and started it in %s.\n", plist, domain)
	if strings.HasPrefix(domain, "user/") {
		fmt.Fprintln(out, "No one is logged in at the Mac's screen, so it runs until logout; after a reboot it starts at the next login there.")
	}
	fmt.Fprintf(out, "It restarts on crash and starts at login. Logs: tail -f %s\n", filepath.Join(home, launchdLog))
	return nil
}

const launchdLog = "Library/Logs/remotty.log"

func launchctl(args ...string) ([]byte, error) {
	return exec.Command("launchctl", args...).CombinedOutput()
}

// loadLaunchAgent unloads any running copy, then loads plist into the login
// (gui) domain, or the user domain when there is no login session: over ssh or
// mosh, remotty's own use case, gui/<uid> does not exist.
func loadLaunchAgent(plist string, run func(...string) ([]byte, error), sleep func(time.Duration)) (string, error) {
	uid := os.Getuid()
	domains := []string{fmt.Sprintf("gui/%d", uid), fmt.Sprintf("user/%d", uid)}
	for _, d := range domains {
		run("bootout", d+"/"+launchdLabel) // not loaded is fine
	}
	// bootout returns before the job is gone, and bootstrapping a label still
	// being torn down fails with "5: Input/output error", leaving it unloaded.
	for i := 0; i < 50 && loaded(domains, run); i++ {
		sleep(100 * time.Millisecond)
	}
	var errs []string
	for _, d := range domains {
		b, err := run("bootstrap", d, plist)
		if err == nil {
			return d, nil
		}
		errs = append(errs, fmt.Sprintf("%s: %v: %s", d, err, strings.TrimSpace(string(b))))
	}
	return "", fmt.Errorf("launchctl bootstrap %s: %s", plist, strings.Join(errs, "; "))
}

func loaded(domains []string, run func(...string) ([]byte, error)) bool {
	for _, d := range domains {
		if _, err := run("print", d+"/"+launchdLabel); err == nil {
			return true
		}
	}
	return false
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
func renderPlist(exe string, args []string, env [3]string, home string) string {
	var argv strings.Builder
	for _, a := range append([]string{exe, "serve"}, args...) {
		fmt.Fprintf(&argv, "\t\t<string>%s</string>\n", html.EscapeString(a))
	}
	e := html.EscapeString
	logFile := e(filepath.Join(home, launchdLog))
	return fmt.Sprintf(plistTemplate, launchdLabel, argv.String(), e(home), e(env[0]), e(env[1]), e(env[2]), logFile, logFile)
}
