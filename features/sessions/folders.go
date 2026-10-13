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
// ponytail: every folder change is read-modify-write; two clients editing folders
// at the same instant can lose one change. A tmux lock would close it.
func (t Tmux) AddFolder(name string) error {
	if err := validName(name); err != nil || name == "" {
		return ErrBadName
	}
	folders, err := t.Folders()
	if err != nil || slices.Contains(folders, name) {
		return err
	}
	return t.saveFolders(append(folders, name))
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

// RenameFolder renames a folder in place and carries its windows along.
func (t Tmux) RenameFolder(old, name string) error {
	if err := validName(name); err != nil || name == "" {
		return ErrBadName
	}
	folders, at, err := t.findFolder(old)
	if err != nil || old == name {
		return err
	}
	if slices.Contains(folders, name) {
		return ErrBadName // two folders with one name could not be told apart
	}
	folders[at] = name
	if err := t.saveFolders(folders); err != nil {
		return err
	}
	return t.retag(old, name)
}

// DeleteFolder removes a folder. Its windows keep running, outside any folder.
func (t Tmux) DeleteFolder(name string) error {
	folders, at, err := t.findFolder(name)
	if err != nil {
		return err
	}
	if err := t.saveFolders(slices.Delete(folders, at, at+1)); err != nil {
		return err
	}
	return t.retag(name, "")
}

// MoveFolder puts folder name right before (or after) folder target.
func (t Tmux) MoveFolder(name, target string, after bool) error {
	folders, at, err := t.findFolder(name)
	if err != nil {
		return err
	}
	folders = slices.Delete(folders, at, at+1)
	to := slices.Index(folders, target)
	if to < 0 {
		return ErrNoFolder
	}
	if after {
		to++
	}
	return t.saveFolders(slices.Insert(folders, to, name))
}

func (t Tmux) findFolder(name string) ([]string, int, error) {
	folders, err := t.Folders()
	if err != nil {
		return nil, 0, err
	}
	at := slices.Index(folders, name)
	if at < 0 {
		return nil, 0, ErrNoFolder
	}
	return folders, at, nil
}

func (t Tmux) saveFolders(folders []string) error {
	if len(folders) == 0 {
		_, err := t.run("set-option", "-u", "-t", t.sessionTarget(), foldersOption)
		return err
	}
	_, err := t.run("set-option", "-t", t.sessionTarget(), foldersOption, strings.Join(folders, "\n"))
	return err
}

// retag moves every window of folder old to folder name ("" for none).
func (t Tmux) retag(old, name string) error {
	windows, err := t.List()
	if err != nil {
		return err
	}
	for _, w := range windows {
		if w.Folder != old {
			continue
		}
		args := []string{"set-option", "-w", "-t", w.ID, folderOption, name}
		if name == "" {
			args = []string{"set-option", "-w", "-u", "-t", w.ID, folderOption}
		}
		if _, err := t.run(args...); err != nil {
			return err
		}
	}
	return nil
}
