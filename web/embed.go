// Package web holds the browser UI. It is plain HTML, CSS and ES modules with
// no build step, embedded into the binary so nothing is fetched at runtime.
package web

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed index.html app.js style.css manifest.json icon.svg search.svg attach.svg mic.svg plus.svg menu.svg folder.svg restore.svg settings.svg features lib
var files embed.FS

// Handler serves the UI. Unknown paths fall back to index.html so a reload on
// any client-side state still lands on the app.
func Handler() http.Handler {
	static := http.FileServerFS(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(files, trim(r.URL.Path)); err != nil {
			r.URL.Path = "/"
		}
		static.ServeHTTP(w, r)
	})
}

func trim(p string) string {
	if p == "/" || p == "" {
		return "index.html"
	}
	return p[1:]
}
