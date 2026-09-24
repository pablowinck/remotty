package access

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newStore(t *testing.T) (Store, *clock) {
	c := &clock{t: time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)}
	return Store{Dir: filepath.Join(t.TempDir(), "state"), Now: c.now}, c
}

func TestCodePairsOnceAndTokenAuthenticates(t *testing.T) {
	s, _ := newStore(t)
	code, err := s.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	token, dev, err := s.Redeem(strings.ToLower(code), "Tab S10")
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if got, ok := s.Lookup(token); !ok || got.ID != dev.ID {
		t.Fatalf("token does not authenticate its device")
	}
	if _, _, err := s.Redeem(code, "outro"); err != ErrInvalidCode {
		t.Fatalf("second use of a code = %v, want ErrInvalidCode", err)
	}
}

func TestExpiredCodeIsRefused(t *testing.T) {
	s, c := newStore(t)
	code, _ := s.NewCode()
	c.t = c.t.Add(codeTTL + time.Second)
	if _, _, err := s.Redeem(code, "x"); err != ErrInvalidCode {
		t.Fatalf("expired code = %v, want ErrInvalidCode", err)
	}
}

func TestFifthWrongGuessBurnsTheCode(t *testing.T) {
	s, _ := newStore(t)
	code, _ := s.NewCode()
	for i := 0; i < maxAttempts; i++ {
		if _, _, err := s.Redeem("AAAAAAAAAA", "x"); err != ErrInvalidCode {
			t.Fatalf("wrong guess %d = %v", i+1, err)
		}
	}
	if _, _, err := s.Redeem(code, "x"); err != ErrInvalidCode {
		t.Fatalf("right code after %d wrong guesses = %v, want ErrInvalidCode", maxAttempts, err)
	}
}

func TestFourWrongGuessesStillAllowTheRightCode(t *testing.T) {
	s, _ := newStore(t)
	code, _ := s.NewCode()
	for i := 0; i < maxAttempts-1; i++ {
		s.Redeem("AAAAAAAAAA", "x")
	}
	if _, _, err := s.Redeem(code, "x"); err != nil {
		t.Fatalf("right code after %d wrong guesses = %v", maxAttempts-1, err)
	}
}

func TestRevokeAndExpiryEndAccess(t *testing.T) {
	s, c := newStore(t)
	code, _ := s.NewCode()
	token, dev, _ := s.Redeem(code, "x")
	if n, _ := s.Revoke(dev.ID); n != 1 {
		t.Fatalf("revoke removed %d devices", n)
	}
	if _, ok := s.Lookup(token); ok || s.Active(dev.ID) {
		t.Fatal("revoked device still authenticates")
	}
	code, _ = s.NewCode()
	token, dev, _ = s.Redeem(code, "y")
	c.t = c.t.Add(deviceTTL + time.Second)
	if _, ok := s.Lookup(token); ok || s.Active(dev.ID) {
		t.Fatal("expired device still authenticates")
	}
}

func TestStoreKeepsOnlyHashesInPrivateFiles(t *testing.T) {
	s, _ := newStore(t)
	code, _ := s.NewCode()
	pending, _ := os.ReadFile(filepath.Join(s.Dir, "pending.json"))
	token, _, _ := s.Redeem(code, "x")
	devices, _ := os.ReadFile(filepath.Join(s.Dir, "devices.json"))
	if strings.Contains(string(pending), code) || strings.Contains(string(devices), token) {
		t.Fatal("a raw secret was written to disk")
	}
	if !strings.Contains(string(devices), hash(token)) {
		t.Fatal("anchor: devices.json should hold the token hash") // proves we read the right file
	}
	for _, f := range []string{"", "devices.json"} {
		info, err := os.Stat(filepath.Join(s.Dir, f))
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			t.Errorf("%q is readable by others: %v", f, perm)
		}
	}
}

// --- HTTP guard ---

const origin = "https://remotty.test"

func guarded(t *testing.T) (Guard, http.Handler) {
	s, _ := newStore(t)
	g := Guard{Store: s, Origins: []string{origin}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/pair", g.HandlePair)
	mux.HandleFunc("GET /api/me", g.RequireDevice(HandleMe))
	return g, g.Wrap(mux)
}

func request(h http.Handler, method, path, host, origin, cookie, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: CookieName, Value: cookie})
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func pairCookie(t *testing.T, g Guard, h http.Handler) *http.Cookie {
	t.Helper()
	code, _ := g.Store.NewCode()
	w := request(h, "POST", "/api/pair", "remotty.test", origin, "", `{"code":"`+code+`","name":"tab"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("pair = %d %s", w.Code, w.Body)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == CookieName {
			return c
		}
	}
	t.Fatal("pairing set no cookie")
	return nil
}

func TestPairingCookieIsLockedDown(t *testing.T) {
	g, h := guarded(t)
	c := pairCookie(t, g, h)
	if !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Domain != "" {
		t.Fatalf("cookie flags too loose: %+v", c)
	}
}

// Safari drops a Secure cookie on http://localhost, so pairing there must set a
// non-Secure one, and only there: the tailnet origin keeps the __Host- cookie,
// and a localhost cookie sent to the tailnet host (or the reverse) is refused.
func TestLocalhostGetsItsOwnCookieAndOnlyLocalhostAcceptsIt(t *testing.T) {
	s, _ := newStore(t)
	local := "http://localhost:7681"
	g := Guard{Store: s, Origins: []string{origin, local}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/pair", g.HandlePair)
	mux.HandleFunc("GET /api/me", g.RequireDevice(HandleMe))
	h := g.Wrap(mux)

	code, _ := s.NewCode()
	w := request(h, "POST", "/api/pair", "localhost:7681", local, "", `{"code":"`+code+`","name":"mac"}`)
	cookies := w.Result().Cookies()
	if w.Code != http.StatusOK || len(cookies) != 1 {
		t.Fatalf("pair on localhost = %d, cookies %+v", w.Code, cookies)
	}
	c := cookies[0]
	if c.Name != LocalCookieName || c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Fatalf("localhost cookie wrong: %+v", c)
	}
	withLocal := func(host string) int {
		r := httptest.NewRequest("GET", "/api/me", nil)
		r.Host = host
		r.AddCookie(&http.Cookie{Name: LocalCookieName, Value: c.Value})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}
	if code := withLocal("localhost:7681"); code != http.StatusOK {
		t.Fatalf("localhost cookie on localhost got %d", code) // anchor for the refusal below
	}
	if code := withLocal("remotty.test"); code != http.StatusUnauthorized {
		t.Fatalf("localhost cookie accepted by the tailnet host: %d", code)
	}
	// A browser paired on localhost before remotty-local existed (Chromium kept
	// the Secure __Host- cookie there) must stay paired after an upgrade.
	if code := request(h, "GET", "/api/me", "localhost:7681", "", c.Value, "").Code; code != http.StatusOK {
		t.Fatalf("an existing __Host- pairing on localhost was dropped: %d", code)
	}
}

func TestAuthenticatedRequestPassesAndUnpairedIsRefused(t *testing.T) {
	g, h := guarded(t)
	c := pairCookie(t, g, h)
	if w := request(h, "GET", "/api/me", "remotty.test", "", c.Value, ""); w.Code != http.StatusOK {
		t.Fatalf("paired device got %d", w.Code) // anchor for the refusals below
	}
	for name, cookie := range map[string]string{"no cookie": "", "forged cookie": "forged"} {
		if w := request(h, "GET", "/api/me", "remotty.test", "", cookie, ""); w.Code != http.StatusUnauthorized {
			t.Errorf("%s got %d, want 401", name, w.Code)
		}
	}
}

func TestCrossOriginAndMissingOriginAreRefused(t *testing.T) {
	g, h := guarded(t)
	code, _ := g.Store.NewCode()
	body := `{"code":"` + code + `"}`
	for name, o := range map[string]string{"foreign origin": "https://evil.test", "no origin": "", "similar origin": origin + ".evil.test"} {
		if w := request(h, "POST", "/api/pair", "remotty.test", o, "", body); w.Code != http.StatusForbidden {
			t.Errorf("%s got %d, want 403", name, w.Code)
		}
	}
	if w := request(h, "POST", "/api/pair", "remotty.test", origin, "", body); w.Code != http.StatusOK {
		t.Fatalf("same-origin pairing got %d after refusals; the code was consumed by a refused request", w.Code)
	}
}

func TestCrossOriginWebSocketUpgradeIsRefused(t *testing.T) {
	g, h := guarded(t)
	c := pairCookie(t, g, h)
	r := httptest.NewRequest("GET", "/api/me", nil)
	r.Host = "remotty.test"
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Origin", "https://evil.test")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin upgrade with a valid cookie got %d, want 403", w.Code)
	}
}

func TestUnknownHostIsRefused(t *testing.T) {
	g, h := guarded(t)
	c := pairCookie(t, g, h)
	if w := request(h, "GET", "/api/me", "evil.test", "", c.Value, ""); w.Code != http.StatusMisdirectedRequest {
		t.Fatalf("rebinding host got %d, want 421", w.Code)
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	_, h := guarded(t)
	for _, w := range []*httptest.ResponseRecorder{
		request(h, "GET", "/nope", "remotty.test", "", "", ""),   // 404
		request(h, "GET", "/api/me", "evil.test", "", "", ""),    // 421
		request(h, "GET", "/api/me", "remotty.test", "", "", ""), // 401
	} {
		if got := w.Header().Get("Content-Security-Policy"); got != CSP {
			t.Errorf("status %d: CSP = %q", w.Code, got)
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("status %d: missing nosniff", w.Code)
		}
	}
}

func TestRevocationCancelsLiveRequests(t *testing.T) {
	g, h := guarded(t)
	c := pairCookie(t, g, h)
	dev, _ := g.Store.Lookup(c.Value)
	cancelled := make(chan struct{})
	handler := g.RequireDevice(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		close(cancelled)
	})
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(c)
	go handler(httptest.NewRecorder(), r)
	time.Sleep(50 * time.Millisecond)
	g.Store.Revoke(dev.ID)
	select {
	case <-cancelled:
	case <-time.After(3 * revocationPoll):
		t.Fatal("revoked device kept its connection open")
	}
}

func TestCleanName(t *testing.T) {
	if got := CleanName("  a\x1b[31mb\n "); got != "a[31mb" {
		t.Errorf("control chars kept: %q", got)
	}
	if got := CleanName(""); got != "device" {
		t.Errorf("empty name = %q", got)
	}
	if got := CleanName(strings.Repeat("é", 50)); len([]rune(got)) != 40 {
		t.Errorf("long name not cut at 40 runes: %d", len([]rune(got)))
	}
}

// coder/websocket accepts "Upgrade: foo, websocket", so matching the header
// exactly would let such a request skip the Origin check.
func TestUpgradeTokenListStillNeedsOrigin(t *testing.T) {
	g, h := guarded(t)
	c := pairCookie(t, g, h)
	for _, upgrade := range []string{"websocket", "WebSocket", "foo, websocket", "websocket, h2c"} {
		r := httptest.NewRequest("GET", "/api/me", nil)
		r.Host = "remotty.test"
		r.Header.Set("Upgrade", upgrade)
		r.Header.Set("Origin", "https://evil.test")
		r.AddCookie(c)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("Upgrade %q from a foreign origin got %d, want 403", upgrade, w.Code)
		}
	}
}

// A device in regular use must never expire: the owner may be away for a year.
// Only a device left unused for a whole deviceTTL does.
func TestUsedDeviceStaysPairedAndIdleDeviceExpires(t *testing.T) {
	s, c := newStore(t)
	code, _ := s.NewCode()
	token, _, _ := s.Redeem(code, "tablet")
	for day := 0; day < 365; day += 7 { // used once a week, for a year
		c.t = c.t.Add(7 * 24 * time.Hour)
		if _, ok := s.Lookup(token); !ok {
			t.Fatalf("device used weekly expired after %d days", day+7)
		}
	}
	c.t = c.t.Add(deviceTTL + time.Hour) // then nobody touches it
	if _, ok := s.Lookup(token); ok {
		t.Fatal("device idle for longer than deviceTTL still authenticates")
	}
}

// Renewal must not rewrite the store on every request: 30 tabs polling every
// 2 s would otherwise hammer the disk and the lock.
func TestRenewalWritesAtMostOncePerDay(t *testing.T) {
	s, c := newStore(t)
	code, _ := s.NewCode()
	token, _, _ := s.Redeem(code, "tablet")
	path := filepath.Join(s.Dir, "devices.json")
	stat := func() time.Time { i, _ := os.Stat(path); return i.ModTime() }

	c.t = c.t.Add(25 * time.Hour)
	s.Lookup(token)
	renewed := stat()
	time.Sleep(20 * time.Millisecond) // mtime resolution
	for i := 0; i < 100; i++ {
		c.t = c.t.Add(time.Minute)
		s.Lookup(token)
	}
	if !stat().Equal(renewed) {
		t.Fatal("devices.json rewritten on requests within the same day")
	}
}

// Renewal re-reads the store under the lock, so a device revoked between the
// token check and the renewal write must stay revoked.
func TestRenewalNeverResurrectsARevokedDevice(t *testing.T) {
	s, c := newStore(t)
	code, _ := s.NewCode()
	token, dev, _ := s.Redeem(code, "tablet")
	c.t = c.t.Add(2 * renewEvery)
	stale, _ := s.readDevices() // what Lookup saw before the revoke
	s.Revoke(dev.ID)
	s.renew(stale[0])
	if _, ok := s.Lookup(token); ok || s.Active(dev.ID) {
		t.Fatal("renewal brought a revoked device back")
	}
}
