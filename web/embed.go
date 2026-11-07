// Package web holds the browser UI. It is plain HTML, CSS and ES modules with
// no build step, embedded into the binary so nothing is fetched at runtime.
package web

import (
	"embed"
	"net/http"
)

//go:embed index.html app.js style.css manifest.json icon.svg search.svg attach.svg mic.svg plus.svg menu.svg folder.svg restore.svg settings.svg features lib
var files embed.FS

// Handler serves the UI. There are no client-side routes (pairing rides in the
// fragment), so an unknown path is a 404: the UI hides Restore on a 404 from /api/restore.
func Handler() http.Handler {
	return http.FileServerFS(files)
}
