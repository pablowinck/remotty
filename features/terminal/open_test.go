package terminal

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestOpenOnlyWebURLsAndOnlyFromThisMachine(t *testing.T) {
	var opened []string
	keep := openURL
	openURL = func(u string) error { opened = append(opened, u); return nil }
	t.Cleanup(func() { openURL = keep })

	post := func(host, peer, body string) int {
		r := httptest.NewRequest(http.MethodPost, "/api/open", strings.NewReader(body))
		r.Host, r.RemoteAddr = host, peer
		w := httptest.NewRecorder()
		handleOpen(w, r)
		return w.Code
	}
	cases := []struct {
		host, peer, url string
		want            int
	}{
		{"localhost:7681", "127.0.0.1:50000", "https://example.com/a?b=1", http.StatusNoContent},
		{"127.0.0.1:7681", "[::1]:50000", "http://example.org", http.StatusNoContent},
		{"box.tail1234.ts.net", "127.0.0.1:50000", "https://example.com", http.StatusForbidden}, // tailscale serve
		{"localhost:7681", "100.64.0.7:50000", "https://example.com", http.StatusForbidden},
		{"localhost:7681", "127.0.0.1:50000", "file:///etc/passwd", http.StatusBadRequest},
		{"localhost:7681", "127.0.0.1:50000", "javascript:alert(1)", http.StatusBadRequest},
		{"localhost:7681", "127.0.0.1:50000", "-a Calculator", http.StatusBadRequest},
	}
	for _, c := range cases {
		if got := post(c.host, c.peer, `{"url":"`+c.url+`"}`); got != c.want {
			t.Errorf("host %s peer %s url %q: status %d, want %d", c.host, c.peer, c.url, got, c.want)
		}
	}
	if want := []string{"https://example.com/a?b=1", "http://example.org"}; strings.Join(opened, " ") != strings.Join(want, " ") {
		t.Fatalf("opened %q, want %q", opened, want)
	}
}

// An opener that fails (xdg-open on a host with no desktop, as under WSL) must
// answer an error, so the page falls back to opening the link itself.
func TestFailedOpenerIsAnErrorNotSilence(t *testing.T) {
	dir := t.TempDir()
	marker := dir + "/ran"
	for _, c := range []struct{ script, want string }{
		{"#!/bin/sh\necho \"$1\" > " + marker + "\nexit 0\n", "ok"},
		{"#!/bin/sh\necho \"$1\" > " + marker + "\nexit 3\n", "error"},
	} {
		opener := dir + "/opener"
		if err := os.WriteFile(opener, []byte(c.script), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("REMOTTY_OPENER", opener)
		os.Remove(marker)
		got := "ok"
		if openURL("https://example.com/x") != nil {
			got = "error"
		}
		if b, _ := os.ReadFile(marker); strings.TrimSpace(string(b)) != "https://example.com/x" {
			t.Fatalf("the opener did not run with the URL: %q", b) // anchor: the opener really ran
		}
		if got != c.want {
			t.Fatalf("opener %q: got %s, want %s", c.script, got, c.want)
		}
	}
}
