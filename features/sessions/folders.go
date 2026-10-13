package sessions

import (
	"errors"
	"slices"
	"strings"
)

// Folders group windows in the tab list. Like the windows themselves they live
// in tmux, so every client sees the same folders: the list on the session (an
// empty folder must survive) and each window's folder as a window option.
const (
	foldersOption = "@remotty-folders" // newline-separated; validName keeps newlines out of a name
	folderOption  = "@remotty-folder"
)

var ErrNoFolder = errors.New("no such folder")

func (t Tmux) sessionTarget() string { return "=" + t.Session + ":" }

// Folders returns the folder names in creation order.
func (t Tmux) Folders() ([]string, error) {
	out, err := t.inSession("show-options", "-v", "-q", "-t", t.sessionTarget(), foldersOption)
	if err != nil {
		return nil, err
	}
	folders := []string{}
	for _, f := range strings.Split(out, "\n") {
		if f != "" {
			folders = append(folders, f)
		}
	}
	return folders, nil
}

// AddFolder creates a folder. Adding one that exists is a no-op.
// ponytail: read-modify-write; two clients adding at the same instant can lose one.
func (t Tmux) AddFolder(name string) error {
	if err := validName(name); err != nil || name == "" {
		return ErrBadName
	}
	folders, err := t.Folders()
	if err != nil || slices.Contains(folders, name) {
		return err
	}
	_, err = t.run("set-option", "-t", t.sessionTarget(), foldersOption, strings.Join(append(folders, name), "\n"))
	return err
}

// SetFolder puts window id in folder; an empty folder takes it out of any.
func (t Tmux) SetFolder(id, folder string) error {
	if !windowIDPattern.MatchString(id) {
		return ErrBadWindowID
	}
	if !t.hasWindow(id) {
		return ErrNoWindow
	}
	if folder == "" {
		_, err := t.run("set-option", "-w", "-u", "-t", id, folderOption)
		return err
	}
	folders, err := t.Folders()
	if err != nil {
		return err
	}
	if !slices.Contains(folders, folder) {
		return ErrNoFolder
	}
	_, err = t.run("set-option", "-w", "-t", id, folderOption, folder)
	return err
}
