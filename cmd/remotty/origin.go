package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// detectOrigins returns the origins the UI is likely served from: the tailnet
// HTTPS name when Tailscale is running, plus localhost for use on the host
// itself. The :0 port is resolved to the bound port by originList.
func detectOrigins() string {
	origins := []string{"http://localhost:0"}
	if name := tailnetName(); name != "" {
		origins = append([]string{"https://" + name}, origins...)
	}
	return strings.Join(origins, ",")
}

// tailscaleCLIs: the one on PATH, then the macOS app's own binary. The App
// Store and standalone apps put no `tailscale` on PATH, and launchd's PATH is
// bare anyway; without it, only localhost was allowed and the tablet was refused.
var tailscaleCLIs = []string{"tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"}

// tailnetName asks the local tailscale daemon for this machine's DNS name.
// Any failure just means "no tailnet": remotty still works on localhost.
func tailnetName() string {
	var out []byte
	var err error
	for _, cli := range tailscaleCLIs {
		if out, err = exec.Command(cli, "status", "--json").Output(); err == nil {
			break
		}
	}
	if err != nil {
		return ""
	}
	var status struct {
		Self struct{ DNSName string }
	}
	if json.Unmarshal(out, &status) != nil {
		return ""
	}
	return strings.TrimSuffix(status.Self.DNSName, ".")
}

// The running server records the URL devices should open, so `remotty pair`
// can print a ready-to-use link instead of making you assemble one.
func urlFile(stateDir string) string { return filepath.Join(stateDir, "url") }

func saveURL(stateDir, origin string) {
	os.MkdirAll(stateDir, 0o700)
	os.WriteFile(urlFile(stateDir), []byte(origin), 0o600)
}

func pairingLink(stateDir, code string) string {
	b, err := os.ReadFile(urlFile(stateDir))
	if err != nil || len(b) == 0 {
		return ""
	}
	// The code goes in the fragment: browsers never send it to any server or log.
	return fmt.Sprintf("%s/#%s", strings.TrimSpace(string(b)), code)
}
