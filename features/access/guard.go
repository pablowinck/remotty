package access

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CookieName uses the __Host- prefix: the browser then refuses it unless it is
// Secure, host-only and Path=/, so a sibling subdomain can never plant or read it.
const CookieName = "__Host-remotty"

// LocalCookieName is the device cookie on http://localhost only. Safari drops
// Secure cookies on plain-http localhost (Chromium does not), so the __Host-
// cookie never came back and Safari on the host could not pair. It is issued
// and accepted only for a loopback Host, so the tailnet origin never takes it.
const LocalCookieName = "remotty-local"

// cookieFor names the device cookie of this request's host, and whether it is Secure.
func cookieFor(r *http.Request) (name string, secure bool) {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	if ip := net.ParseIP(host); host == "localhost" || (ip != nil && ip.IsLoopback()) {
		return LocalCookieName, false
	}
	return CookieName, true
}

// CSP allows nothing from anywhere but this host. 'unsafe-inline' is limited to
// styles because xterm.js injects a <style> element; scripts never get it.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'"

// Guard wraps every route. Origins are the exact origins (scheme://host[:port])
// the UI is served from; Host headers and Origin headers must match them.
type Guard struct {
	Store   Store
	Origins []string
}

type deviceKey struct{}

// Wrap adds security headers to every response and rejects requests aimed at an
// unknown host (DNS rebinding) or sent cross-origin (CSRF, WebSocket hijacking).
func (g Guard) Wrap(next http.Handler) http.Handler {
	hosts := map[string]bool{}
	origins := map[string]bool{}
	for _, o := range g.Origins {
		origins[o] = true
		if u, err := url.Parse(o); err == nil {
			hosts[u.Host] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setHeaders(w.Header())
		if !hosts[r.Host] {
			http.Error(w, "unknown host", http.StatusMisdirectedRequest)
			return
		}
		if needsOrigin(r) && !origins[r.Header.Get("Origin")] {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func setHeaders(h http.Header) {
	h.Set("Content-Security-Policy", CSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	// Microphone for voice notes, from this page only; camera and location stay off.
	h.Set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")
	h.Set("Cache-Control", "no-store")
}

// needsOrigin: anything that changes state, plus WebSocket upgrades, which are
// GETs that browsers happily send cross-site with cookies attached. Upgrade is
// a token list ("foo, websocket"), and the handshake key alone is enough for
// some servers, so either one marks the request as an upgrade.
func needsOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-WebSocket-Key") != "" {
		return true
	}
	for _, token := range strings.Split(r.Header.Get("Upgrade"), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "websocket") {
			return true
		}
	}
	return r.Method != http.MethodGet && r.Method != http.MethodHead
}

// OriginHosts returns host[:port] of each allowed origin, the form the
// WebSocket library's own Origin check expects.
func (g Guard) OriginHosts() []string {
	var hosts []string
	for _, o := range g.Origins {
		if u, err := url.Parse(o); err == nil {
			hosts = append(hosts, u.Host)
		}
	}
	return hosts
}

// RequireDevice lets a request through only with a live device cookie. The
// request context is cancelled as soon as that device is revoked, which closes
// any terminal it holds open.
func (g Guard) RequireDevice(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name, _ := cookieFor(r)
		c, err := r.Cookie(name)
		if err != nil && name == LocalCookieName {
			// Paired before remotty-local existed: Chromium keeps a Secure cookie on localhost.
			c, err = r.Cookie(CookieName)
		}
		if err != nil {
			http.Error(w, "not paired", http.StatusUnauthorized)
			return
		}
		dev, ok := g.Store.Lookup(c.Value)
		if !ok {
			http.Error(w, "not paired", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(g.watch(r.Context(), dev.ID), deviceKey{}, dev)
		next(w, r.WithContext(ctx))
	}
}

// revocationPoll bounds how long a revoked device keeps a terminal open.
const revocationPoll = 500 * time.Millisecond

func (g Guard) watch(parent context.Context, id string) context.Context {
	ctx, cancel := context.WithCancel(parent)
	go func() {
		t := time.NewTicker(revocationPoll)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !g.Store.Active(id) {
					cancel()
					return
				}
			}
		}
	}()
	return ctx
}

// DeviceFrom returns the device RequireDevice attached to the request.
func DeviceFrom(ctx context.Context) Device {
	d, _ := ctx.Value(deviceKey{}).(Device)
	return d
}

// HandlePair redeems a pairing code and sets the device cookie.
func (g Guard) HandlePair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	token, dev, err := g.Store.Redeem(req.Code, req.Name)
	if errors.Is(err, ErrInvalidCode) {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, "could not pair", http.StatusInternalServerError)
		return
	}
	name, secure := cookieFor(r)
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: token, Path: "/", Expires: dev.Expires,
		Secure: secure, HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
	writeJSONResponse(w, map[string]string{"name": dev.Name})
}

// HandleMe tells the UI which device it is, or 401 through RequireDevice.
func HandleMe(w http.ResponseWriter, r *http.Request) {
	writeJSONResponse(w, map[string]string{"name": DeviceFrom(r.Context()).Name})
}

func writeJSONResponse(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
