package main

import (
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRenderUnitQuotesArgumentsForSystemd(t *testing.T) {
	unit := renderUnit("/home/u/go/bin/remotty", []string{"-origin", "https://a.ts.net,http://localhost:0", `we"ird %i`})
	want := `ExecStart=/home/u/go/bin/remotty serve "-origin" "https://a.ts.net,http://localhost:0" "we\"ird %%i"`
	if !strings.Contains(unit, want+"\n") {
		t.Fatalf("unit ExecStart wrong:\n%s\nwant line:\n%s", unit, want)
	}
	for _, line := range []string{"Restart=on-failure", "KillMode=process", "WantedBy=default.target"} {
		if !strings.Contains(unit, line) {
			t.Errorf("unit misses %q", line)
		}
	}
}

// The plist is XML: a flag value with & or < must not break it, and each
// argument must stay one <string>, since launchd does no word splitting.
func TestRenderPlistEscapesAndKeepsArgumentsWhole(t *testing.T) {
	p := renderPlist("/Users/u/go/bin/remotty", []string{"-restore-command", `claude --resume && echo "<ok>"`}, [3]string{"/opt/homebrew/bin:/usr/bin", "/bin/zsh", "pt_BR.UTF-8"}, "/Users/u")
	for _, want := range []string{
		"<string>/Users/u/go/bin/remotty</string>\n\t\t<string>serve</string>\n\t\t<string>-restore-command</string>\n",
		"<string>claude --resume &amp;&amp; echo &#34;&lt;ok&gt;&#34;</string>",
		"<string>/opt/homebrew/bin:/usr/bin</string>",
		"<key>AbandonProcessGroup</key>\n\t<true/>",
		"<key>SuccessfulExit</key>\n\t\t<false/>",
		// launchd starts in /: new tmux windows opened there, not in $HOME.
		"<key>WorkingDirectory</key>\n\t<string>/Users/u</string>",
		"<string>/Users/u/Library/Logs/remotty.log</string>",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("plist misses %q:\n%s", want, p)
		}
	}
	if err := xml.Unmarshal([]byte(p), new(struct{})); err != nil {
		t.Fatalf("plist is not well-formed XML: %v", err)
	}
}

func TestRenderUnitWithoutFlags(t *testing.T) {
	if unit := renderUnit("/bin/remotty", nil); !strings.Contains(unit, "ExecStart=/bin/remotty serve \n") {
		t.Fatalf("unit without flags:\n%s", unit)
	}
}

// fakeLaunchctl records calls. The job stays listed for `teardown` prints after
// bootout, as launchd's asynchronous teardown does, and gui/ bootstrap fails
// when there is no login session.
type fakeLaunchctl struct {
	calls    []string
	teardown int
	noGUI    bool
}

func (f *fakeLaunchctl) run(args ...string) ([]byte, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch {
	case args[0] == "print" && f.teardown > 0:
		f.teardown--
		return nil, nil
	case args[0] == "bootstrap" && f.teardown > 0:
		return []byte("Bootstrap failed: 5: Input/output error"), errors.New("exit status 5")
	case args[0] == "bootstrap" && f.noGUI && strings.HasPrefix(args[1], "gui/"):
		return []byte("Bootstrap failed: 125: Domain does not support specified action"), errors.New("exit status 125")
	case args[0] == "bootstrap":
		return nil, nil
	}
	return nil, errors.New("not found")
}

// Re-running install while remotty runs must wait for bootout to finish, or
// bootstrap fails and the service is left unloaded.
func TestLoadLaunchAgentWaitsForTheOldJobToGo(t *testing.T) {
	f := &fakeLaunchctl{teardown: 3}
	sleeps := 0
	domain, err := loadLaunchAgent("/p.plist", f.run, func(time.Duration) { sleeps++ })
	if err != nil || domain != fmt.Sprintf("gui/%d", os.Getuid()) {
		t.Fatalf("domain %q, err %v, calls %v", domain, err, f.calls)
	}
	if sleeps == 0 {
		t.Fatalf("bootstrap did not wait for the teardown: %v", f.calls)
	}
}

// Over ssh or mosh there is no gui/ domain: install must still load the agent.
func TestLoadLaunchAgentFallsBackToTheUserDomain(t *testing.T) {
	f := &fakeLaunchctl{noGUI: true}
	domain, err := loadLaunchAgent("/p.plist", f.run, func(time.Duration) {})
	if err != nil || domain != fmt.Sprintf("user/%d", os.Getuid()) {
		t.Fatalf("domain %q, err %v, calls %v", domain, err, f.calls)
	}
}
