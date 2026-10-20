package sessions

import (
	"errors"
	"slices"
	"strings"
)

// Folders group windows in the tab list. Like the windows themselves they live
// in tmux, so every client sees the same folders: the list on the session (an
// empty folder must survive) and each window's folder as a window option.
// Folders nest: a folder is stored as its whole path, and the list keeps every
// folder right after its parent, so reading it top to bottom is already the tree.
const (
	foldersOption = "@remotty-folders" // newline-separated; validName keeps newlines out of a name
	folderOption  = "@remotty-folder"
	folderSep     = "\x1f" // validName refuses control characters, so no segment holds one
)

var ErrNoFolder = errors.New("no such folder")

func folderParent(path string) string {
	at := strings.LastIndex(path, folderSep)
	if at < 0 {
		return ""
	}
	return path[:at]
}

func folderLeaf(path string) string { return path[strings.LastIndex(path, folderSep)+1:] }

func folderPath(parent, leaf string) string {
	if parent == "" {
		return leaf
	}
	return parent + folderSep + leaf
}

// under reports whether f is path or a folder inside it.
func under(f, path string) bool { return f == path || strings.HasPrefix(f, path+folderSep) }

// splitSubtree takes path and everything inside it out of folders, keeping the
// order of both halves.
func splitSubtree(folders []string, path string) (subtree, rest []string) {
	for _, f := range folders {
		if under(f, path) {
			subtree = append(subtree, f)
		} else {
			rest = append(rest, f)
		}
	}
	return subtree, rest
}

// endOfSubtree returns the index just past the folder at at and its own folders.
func endOfSubtree(folders []string, at int) int {
	to := at + 1
	for to < len(folders) && under(folders[to], folders[at]) {
		to++
	}
	return to
}

// lastChild returns where a new folder of parent goes: after parent's own
// folders, or at the end of the list for a top-level one.
func lastChild(folders []string, parent string) int {
	if parent == "" {
		return len(folders)
	}
	at := slices.Index(folders, parent)
	if at < 0 {
		return len(folders)
	}
	return endOfSubtree(folders, at)
}

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

// RenameFolder renames a folder in place; its folders and windows go along.
func (t Tmux) RenameFolder(old, name string) error {
	if err := validName(name); err != nil || name == "" {
		return ErrBadName
	}
	return t.relocate(old, folderPath(folderParent(old), name), func(rest []string, at int) (int, error) { return at, nil })
}

// DeleteFolder removes a folder and the folders inside it. Their windows keep
// running, in the deleted folder's parent (outside any folder at the top).
func (t Tmux) DeleteFolder(name string) error {
	folders, _, err := t.findFolder(name)
	if err != nil {
		return err
	}
	_, rest := splitSubtree(folders, name)
	if err := t.saveFolders(rest); err != nil {
		return err
	}
	parent := folderParent(name)
	return t.retag(func(f string) (string, bool) { return parent, under(f, name) })
}

// MoveFolder puts folder name right before (or after) folder target, as its
// sibling: dropped next to a folder elsewhere in the tree, it moves there.
func (t Tmux) MoveFolder(name, target string, after bool) error {
	return t.relocate(name, folderPath(folderParent(target), folderLeaf(name)), func(rest []string, _ int) (int, error) {
		to := slices.Index(rest, target)
		if to < 0 {
			return 0, ErrNoFolder
		}
		if after {
			to = endOfSubtree(rest, to)
		}
		return to, nil
	})
}

// NestFolder puts folder name inside parent, after parent's own folders; an
// empty parent takes it to the top level.
func (t Tmux) NestFolder(name, parent string) error {
	return t.relocate(name, folderPath(parent, folderLeaf(name)), func(rest []string, _ int) (int, error) {
		if parent != "" && !slices.Contains(rest, parent) {
			return 0, ErrNoFolder
		}
		return lastChild(rest, parent), nil
	})
}

// relocate takes folder path and the folders inside it out of the list, renames
// them to live under newPath, puts them back where insertAt says (given what is
// left and where path was), and carries the windows along.
func (t Tmux) relocate(path, newPath string, insertAt func(rest []string, at int) (int, error)) error {
	folders, at, err := t.findFolder(path)
	if err != nil {
		return err
	}
	if newPath != path && (slices.Contains(folders, newPath) || under(newPath, path)) {
		return ErrBadName // two folders with one path could not be told apart; nor can a folder hold itself
	}
	subtree, rest := splitSubtree(folders, path)
	to, err := insertAt(rest, at)
	if err != nil {
		return err
	}
	for i, f := range subtree {
		subtree[i] = newPath + f[len(path):]
	}
	if err := t.saveFolders(slices.Insert(rest, to, subtree...)); err != nil {
		return err
	}
	return t.retag(func(f string) (string, bool) {
		if !under(f, path) {
			return "", false
		}
		return newPath + f[len(path):], true
	})
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

// retag gives every window the folder newFolder maps its folder to, when it
// says so; "" takes the window out of any folder.
func (t Tmux) retag(newFolder func(string) (string, bool)) error {
	windows, err := t.List()
	if err != nil {
		return err
	}
	for _, w := range windows {
		name, ok := newFolder(w.Folder)
		if !ok || name == w.Folder {
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
