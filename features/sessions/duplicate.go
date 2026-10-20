package sessions

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Duplicate opens a window right after id, in the same folder and directory,
// running again what runs in the foreground there (claude with its flags, say),
// then staying as a plain shell like Restore does. A window at its prompt
// duplicates into a fresh shell in the same directory.
func (t Tmux) Duplicate(id string) (string, error) {
	if !windowIDPattern.MatchString(id) {
		return "", ErrBadWindowID
	}
	if !t.hasWindow(id) {
		return "", ErrNoWindow
	}
	out, err := t.run("display-message", "-p", "-t", id, "#{pane_pid}\t#{pane_current_path}\t#{window_name}\t#{"+folderOption+"}") // folder last, see listFormat
	if err != nil {
		return "", err
	}
	f := strings.SplitN(strings.TrimRight(out, "\n"), "\t", 4)
	if len(f) != 4 {
		return "", ErrNoWindow
	}
	pid, _ := strconv.Atoi(f[0])
	args := []string{"new-window", "-d", "-a", "-P", "-F", "#{window_id}", "-t", id, "-c", f[1]}
	if f[2] != "" && validName(f[2]) == nil { // programs inside set the name
		args = append(args, "-n", f[2])
	}
	if line := foreground(pid); line != "" {
		shell := userShell()
		args = append(args, shell, "-ic", line+"; exec "+shellQuote(shell))
	}
	newID, err := t.run(args...)
	newID = strings.TrimSpace(newID)
	if err != nil || f[3] == "" {
		return newID, err
	}
	_, err = t.run("set-option", "-w", "-t", newID, folderOption, f[3])
	return newID, err
}

// foreground returns, shell-quoted, the argv of the job running in the
// foreground of shellPID's terminal, or "" when the shell itself is there.
func foreground(shellPID int) string {
	pgid := foregroundGroup(shellPID)
	if pgid == 0 || pgid == shellPID {
		return ""
	}
	argv := cmdline(pgid)
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = shellQuote(a)
	}
	return strings.Join(quoted, " ")
}

// foregroundGroup is the terminal's foreground process group (tpgid), whose
// leader is the command the user typed at the prompt.
func foregroundGroup(pid int) int {
	if fields := statFields(pid); len(fields) >= 6 {
		n, _ := strconv.Atoi(fields[5])
		return n
	}
	out, _ := exec.Command("ps", "-o", "tpgid=", "-p", strconv.Itoa(pid)).Output()
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

// cmdline keeps argument boundaries from /proc. ponytail: elsewhere (macOS) ps
// joins argv with spaces, so an argument with a space splits in two; sysctl
// KERN_PROCARGS2 would keep it.
func cmdline(pid int) []string {
	if b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline")); err == nil {
		return strings.Split(strings.TrimRight(string(b), "\x00"), "\x00")
	}
	out, _ := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(pid)).Output()
	return strings.Fields(string(out))
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
