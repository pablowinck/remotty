package web

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// The UI has no client-side routes, so an unknown path, above all under /api/,
// must be a 404 and not index.html: the UI hides Restore on a 404.
func TestUnknownPathIs404(t *testing.T) {
	cases := []struct {
		path string
		code int
	}{{"/", 200}, {"/app.js", 200}, {"/api/nope", 404}, {"/nope", 404}}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		Handler().ServeHTTP(rec, httptest.NewRequest("GET", c.path, nil))
		if rec.Code != c.code {
			t.Errorf("GET %s = %d, want %d", c.path, rec.Code, c.code)
		}
	}
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(rec.Body.String(), `<script type="module" src="/app.js">`) {
		t.Errorf("GET / does not serve index.html")
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("GET / Content-Type = %q", ct)
	}
}
