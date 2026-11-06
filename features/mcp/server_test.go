package mcp

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pablowinck/remotty/features/sessions"
)

// newToolbox runs against a private tmux server, never the user's.
func newToolbox(t *testing.T) Toolbox {
	t.Helper()
	dir, err := os.MkdirTemp("", "rtm") // short: a unix socket path caps at 104 bytes on macOS
	if err != nil {
		t.Fatal(err)
	}
	tm := sessions.Tmux{Socket: filepath.Join(dir, "tmux.sock"), Session: "main"}
	t.Cleanup(func() {
		exec.Command("tmux", "-S", tm.Socket, "kill-server").Run()
		os.RemoveAll(dir)
	})
	if err := tm.Ensure(); err != nil {
		t.Fatal(err)
	}
	return Toolbox{Tmux: tm}
}

type reply struct {
	ID     int `json:"id"`
	Result struct {
		ProtocolVersion string `json:"protocolVersion"`
		Tools           []struct {
			Name        string                     `json:"name"`
			InputSchema map[string]json.RawMessage `json:"inputSchema"`
		} `json:"tools"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	} `json:"result"`
	Error *rpcError `json:"error"`
}

// session feeds lines to Serve and returns one reply per output line.
func session(t *testing.T, b Toolbox, lines ...string) []reply {
	t.Helper()
	var out bytes.Buffer
	if err := Serve(strings.NewReader(strings.Join(lines, "\n")+"\n"), &out, b); err != nil {
		t.Fatalf("serve: %v", err)
	}
	var replies []reply
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var r reply
		if err := json.Unmarshal([]byte(l), &r); err != nil {
			t.Fatalf("not JSON on stdout: %q", l)
		}
		replies = append(replies, r)
	}
	return replies
}

func call(id int, name, arguments string) string {
	return `{"jsonrpc":"2.0","id":` + itoa(id) + `,"method":"tools/call","params":{"name":"` + name + `","arguments":` + arguments + `}}`
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func text(t *testing.T, r reply) string {
	t.Helper()
	if r.Error != nil || len(r.Result.Content) == 0 {
		t.Fatalf("reply %d: no content (error %+v)", r.ID, r.Error)
	}
	return r.Result.Content[0].Text
}

// The handshake every client does; the notification in the middle gets no
// reply, so the second reply is the tools list.
func TestHandshakeAndToolsList(t *testing.T) {
	got := session(t, Toolbox{},
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"resources/list"}`,
	)
	if len(got) != 3 {
		t.Fatalf("want 3 replies (notification unanswered), got %d: %+v", len(got), got)
	}
	if got[0].ID != 1 || got[0].Result.ProtocolVersion != "2025-03-26" {
		t.Errorf("initialize = %+v", got[0])
	}
	names := map[string]bool{}
	for _, tl := range got[1].Result.Tools {
		names[tl.Name] = true
		// Claude Code rejects the whole list over one null "required".
		if req, has := tl.InputSchema["required"]; has && string(req)[0] != '[' {
			t.Errorf("%s: required is %s, want an array or absent", tl.Name, req)
		}
		if string(tl.InputSchema["type"]) != `"object"` {
			t.Errorf("%s: inputSchema type is %s", tl.Name, tl.InputSchema["type"])
		}
	}
	for _, want := range []string{"list_agents", "create_agent", "send_text", "send_keys", "read_screen", "create_folder", "move_agent"} {
		if !names[want] {
			t.Errorf("tools/list misses %s", want)
		}
	}
	if got[2].Error == nil || got[2].Error.Code != -32601 {
		t.Errorf("unknown method = %+v, want -32601", got[2])
	}
}

// An orchestrator builds a team: a nested folder, an agent in it running a
// command, and it reads back the result only execution produces.
func TestOrchestratorCreatesAgentInNestedFolderAndReadsIt(t *testing.T) {
	b := newToolbox(t)
	got := session(t, b,
		call(1, "create_folder", `{"name":"jobs"}`),
		call(2, "create_folder", `{"name":"seo","parent":"jobs"}`),
		call(3, "create_agent", `{"name":"redator","folder":"jobs/seo","command":"echo out-$((3*5))"}`),
		call(4, "list_agents", `{}`),
	)
	for _, r := range got[:3] {
		if r.Result.IsError {
			t.Fatalf("call %d failed: %s", r.ID, text(t, r))
		}
	}
	var created struct{ ID string }
	json.Unmarshal([]byte(text(t, got[2])), &created)
	list := text(t, got[3])
	if !strings.Contains(list, `"name":"redator"`) || !strings.Contains(list, `"folder":"jobs/seo"`) || !strings.Contains(list, `"folders":["jobs","jobs/seo"]`) {
		t.Fatalf("list_agents = %s", list)
	}
	waitFor(t, b, created.ID, "out-15")
}

func waitFor(t *testing.T, b Toolbox, id, want string) {
	t.Helper()
	var screen string
	for range 50 {
		r := session(t, b, call(1, "read_screen", `{"id":"`+id+`"}`))
		if screen = text(t, r[0]); strings.Contains(screen, want) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("read_screen of %s never showed %q:\n%s", id, want, screen)
}

// A tool's failure reaches the model as an isError result it can read; the
// healthy call next to it proves the server was answering.
func TestToolFailureIsAResultTheModelReads(t *testing.T) {
	b := newToolbox(t)
	got := session(t, b,
		call(1, "send_keys", `{"id":"@999","keys":["Enter"]}`),
		call(2, "send_keys", `{"id":"@0","keys":["rm -rf"]}`),
		call(3, "list_agents", `{}`),
		call(4, "no_such_tool", `{}`),
	)
	if !got[0].Result.IsError || !strings.Contains(text(t, got[0]), "no such window") {
		t.Errorf("missing window = %+v", got[0])
	}
	if !got[1].Result.IsError || !strings.Contains(text(t, got[1]), "invalid key") {
		t.Errorf("bad key = %+v", got[1])
	}
	if got[2].Result.IsError || !strings.Contains(text(t, got[2]), `"id":"@0"`) {
		t.Errorf("list_agents = %+v", got[2])
	}
	if got[3].Error == nil || got[3].Error.Code != -32602 {
		t.Errorf("unknown tool = %+v, want -32602", got[3])
	}
}

// create_folder with a parent must not move an existing top-level folder of
// the same name into it.
func TestCreateNestedFolderKeepsTopLevelNamesake(t *testing.T) {
	b := newToolbox(t)
	got := session(t, b,
		call(1, "create_folder", `{"name":"jobs"}`),
		call(2, "create_folder", `{"name":"seo"}`),
		call(3, "create_folder", `{"name":"seo","parent":"jobs"}`),
		call(4, "list_agents", `{}`),
	)
	if !got[2].Result.IsError {
		t.Errorf("nesting a namesake succeeded: %s", text(t, got[2]))
	}
	if list := text(t, got[3]); !strings.Contains(list, `"folders":["jobs","seo"]`) {
		t.Errorf("folders changed: %s", list)
	}
}

func TestListMarksTheCallersOwnWindow(t *testing.T) {
	b := newToolbox(t)
	other, _ := b.Tmux.Create("outro")
	pane, _ := exec.Command("tmux", "-S", b.Tmux.Socket, "display-message", "-p", "-t", other, "#{pane_id}").Output()
	b.Self = b.Tmux.WindowOf(strings.TrimSpace(string(pane)))
	list := text(t, session(t, b, call(1, "list_agents", `{}`))[0])
	if !strings.Contains(list, `"id":"`+other+`","index":2,"name":"outro","active":false,"bell":false,"activity":false,"silence":false,"folder":"","self":true`) {
		t.Fatalf("own window %s not marked self: %s", other, list)
	}
	if strings.Count(list, `"self":true`) != 1 {
		t.Fatalf("more than one self: %s", list)
	}
}
