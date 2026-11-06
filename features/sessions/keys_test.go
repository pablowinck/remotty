package sessions

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// waitScreen polls Capture until it holds want, so the test proves what the
// shell ran, not only what it echoed.
func waitScreen(t *testing.T, tm Tmux, id, want string) string {
	t.Helper()
	var screen string
	for range 50 {
		screen, _ = tm.Capture(id, 0)
		if strings.Contains(screen, want) {
			return screen
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("screen of %s never showed %q:\n%s", id, want, screen)
	return ""
}

// readyWindow opens a /bin/sh window and waits for its prompt: text sent to a
// shell still starting is echoed by the tty but run late, which hid a stray
// Enter from the test below.
func readyWindow(t *testing.T) (Tmux, string) {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh") // fast and the same for everyone
	tm := newTestTmux(t)
	id, err := tm.Create("alvo")
	if err != nil {
		t.Fatal(err)
	}
	if err := tm.SendText(id, "echo pronto-$((1+1))", true); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, tm, id, "pronto-2")
	return tm, id
}

func TestSendTextRunsIt(t *testing.T) {
	tm, id := readyWindow(t)
	// The trailing ";" is what send-keys -l lost as a tmux command separator:
	// without it the line ends in "\" and the shell waits for more.
	if err := tm.SendText(id, `echo r-$((3*5)) \;`, true); err != nil {
		t.Fatalf("send text: %v", err)
	}
	waitScreen(t, tm, id, "r-15 ;")
}

func TestSendTextWithoutEnterOnlyTypes(t *testing.T) {
	tm, id := readyWindow(t)
	if err := tm.SendText(id, "echo t-$((2*4))", false); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, tm, id, "echo t-$((2*4))")
	time.Sleep(300 * time.Millisecond)
	if screen, _ := tm.Capture(id, 0); strings.Contains(screen, "t-8") {
		t.Fatalf("ran without Enter:\n%s", screen)
	}
	if err := tm.SendKeys(id, []string{"Enter"}); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, tm, id, "t-8")
}

func TestSendKeysPressesThem(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh") // the same read in every user's shell
	tm := newTestTmux(t)
	id, _ := tm.Create("alvo")
	tm.SendText(id, `read k; echo "k=$k-$((1+1))"`, true)
	time.Sleep(300 * time.Millisecond)
	if err := tm.SendKeys(id, []string{"7", "Enter"}); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, tm, id, "k=7-2")
}

func TestSendKeysRefusesWhatIsNotAKey(t *testing.T) {
	tm := newTestTmux(t)
	id, _ := tm.Create("alvo")
	for _, keys := range [][]string{{}, {"ls"}, {"-t"}, {";"}, {"Enter", "kill-server"}, {"C-b"}} {
		if err := tm.SendKeys(id, keys); !errors.Is(err, ErrBadKey) {
			t.Errorf("SendKeys(%q) = %v, want ErrBadKey", keys, err)
		}
	}
	if err := tm.SendKeys(id, []string{"Escape", "Up", "a", "9"}); err != nil {
		t.Errorf("refused real keys: %v", err)
	}
}

func TestKeysRejectBadAndMissingWindows(t *testing.T) {
	tm := newTestTmux(t)
	if err := tm.SendText("@1;kill-server", "x", true); err != ErrBadWindowID {
		t.Errorf("SendText bad id = %v", err)
	}
	if err := tm.SendKeys("@999", []string{"Enter"}); err != ErrNoWindow {
		t.Errorf("SendKeys missing window = %v", err)
	}
	if _, err := tm.Capture("@999", 0); err != ErrNoWindow {
		t.Errorf("Capture missing window = %v", err)
	}
}

func TestCaptureScrollback(t *testing.T) {
	tm := newTestTmux(t)
	id, _ := tm.Create("alvo")
	tm.SendText(id, "seq 1 200 | sed 's/^/n-/'; echo fim-$((4*4))", true)
	waitScreen(t, tm, id, "fim-16")
	visible, _ := tm.Capture(id, 0)
	if strings.Contains(visible, "n-1\n") {
		t.Fatalf("n-1 should have scrolled off:\n%s", visible)
	}
	if all, _ := tm.Capture(id, 500); !strings.Contains(all, "n-1\n") {
		t.Fatalf("scrollback misses n-1:\n%s", all)
	}
}

func TestCreateAtStartsInDir(t *testing.T) {
	tm := newTestTmux(t)
	dir, _ := os.MkdirTemp("", "rtdir")
	defer os.RemoveAll(dir)
	id, err := tm.CreateAt("aqui", dir)
	if err != nil {
		t.Fatal(err)
	}
	tm.SendText(id, `echo "em:$(pwd):$((6*7))"`, true)
	waitScreen(t, tm, id, "em:"+dir+":42")
}
