package mcp

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/pablowinck/remotty/features/sessions"
)

// Toolbox is what the tools act on: the tmux session the browser shows, and the
// window the calling agent itself runs in ("" when it runs outside tmux).
type Toolbox struct {
	Tmux sessions.Tmux
	Self string
}

// args is every argument any tool takes; each tool reads the ones it declares.
type args struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Folder     string   `json:"folder"`
	Parent     string   `json:"parent"`
	Dir        string   `json:"dir"`
	Command    string   `json:"command"`
	Text       string   `json:"text"`
	Enter      *bool    `json:"enter"`
	Keys       []string `json:"keys"`
	Scrollback int      `json:"scrollback"`
	Until      string   `json:"until"`
	Quiet      float64  `json:"quiet_seconds"`
	Timeout    float64  `json:"timeout_seconds"`
}

type tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	run         func(Toolbox, args) (any, error)
}

// schema builds a tool's inputSchema. Claude Code refused the whole tools list
// when one "required" was null, so a tool without required arguments omits it.
func schema(required []string, props map[string]any) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

var (
	idProp     = map[string]any{"type": "string", "description": `window id from list_agents, like "@3"`}
	nameProp   = map[string]any{"type": "string", "description": "at most 64 characters, no control characters"}
	folderProp = map[string]any{"type": "string", "description": `folder path, "/" between levels, like "jobs/seo"; "" for none`}
)

var tools = []tool{
	{Name: "list_agents", Description: "List the agent windows (id, name, folder, whether idle or ringing) and every folder.",
		InputSchema: schema(nil, map[string]any{}), run: listAgents},
	{Name: "create_agent", Description: "Open a new window, optionally in a folder and directory, optionally typing a command into it (e.g. \"claude\"). Returns its id.",
		InputSchema: schema([]string{"name"}, map[string]any{"name": nameProp, "folder": folderProp,
			"dir": map[string]any{"type": "string", "description": "starting directory"}, "command": map[string]any{"type": "string", "description": "typed and run in the new shell"}}),
		run: createAgent},
	{Name: "rename_agent", Description: "Rename a window.", InputSchema: schema([]string{"id", "name"}, map[string]any{"id": idProp, "name": nameProp}),
		run: func(b Toolbox, a args) (any, error) { return ok(b.Tmux.Rename(a.ID, a.Name)) }},
	{Name: "close_agent", Description: "Close a window, killing whatever runs in it.", InputSchema: schema([]string{"id"}, map[string]any{"id": idProp}),
		run: func(b Toolbox, a args) (any, error) { return ok(b.Tmux.Close(a.ID)) }},
	{Name: "duplicate_agent", Description: "Open a copy of a window right after it, rerunning its foreground command in the same directory and folder. Returns the new id.",
		InputSchema: schema([]string{"id"}, map[string]any{"id": idProp}),
		run:         func(b Toolbox, a args) (any, error) { return idResult(b.Tmux.Duplicate(a.ID)) }},
	{Name: "move_agent", Description: "Put a window in a folder; \"\" takes it out of any.", InputSchema: schema([]string{"id", "folder"}, map[string]any{"id": idProp, "folder": folderProp}),
		run: func(b Toolbox, a args) (any, error) { return ok(b.Tmux.SetFolder(a.ID, toPath(a.Folder))) }},
	{Name: "create_folder", Description: "Create a folder, inside parent when given.", InputSchema: schema([]string{"name"}, map[string]any{"name": nameProp, "parent": folderProp}),
		run: createFolder},
	{Name: "rename_folder", Description: "Rename a folder; what is inside goes along.", InputSchema: schema([]string{"folder", "name"}, map[string]any{"folder": folderProp, "name": nameProp}),
		run: func(b Toolbox, a args) (any, error) { return ok(b.Tmux.RenameFolder(toPath(a.Folder), a.Name)) }},
	{Name: "delete_folder", Description: "Delete a folder and the folders inside it. Their windows keep running, moved to its parent.",
		InputSchema: schema([]string{"folder"}, map[string]any{"folder": folderProp}),
		run:         func(b Toolbox, a args) (any, error) { return ok(b.Tmux.DeleteFolder(toPath(a.Folder))) }},
	{Name: "nest_folder", Description: "Move a folder inside parent; \"\" takes it to the top level.", InputSchema: schema([]string{"folder", "parent"}, map[string]any{"folder": folderProp, "parent": folderProp}),
		run: func(b Toolbox, a args) (any, error) { return ok(b.Tmux.NestFolder(toPath(a.Folder), toPath(a.Parent))) }},
	{Name: "send_text", Description: "Type text into a window, as a paste, then press Enter unless enter is false. This is how you prompt another agent.",
		InputSchema: schema([]string{"id", "text"}, map[string]any{"id": idProp, "text": map[string]any{"type": "string"}, "enter": map[string]any{"type": "boolean", "default": true}}),
		run:         sendText},
	{Name: "send_keys", Description: "Press keys in a window, in order: Enter, Escape, Tab, BTab, Space, BSpace, Up, Down, Left, Right, Home, End, PageUp, PageDown, C-c, C-d, C-u, C-l, or one letter or digit each. Use it to pick an option in a menu.",
		InputSchema: schema([]string{"id", "keys"}, map[string]any{"id": idProp, "keys": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}}),
		run:         func(b Toolbox, a args) (any, error) { return ok(b.Tmux.SendKeys(a.ID, a.Keys)) }},
	{Name: "read_screen", Description: "Return what a window shows now, plus up to scrollback earlier lines (max 2000).",
		InputSchema: schema([]string{"id"}, map[string]any{"id": idProp, "scrollback": map[string]any{"type": "integer", "minimum": 0}}),
		run:         func(b Toolbox, a args) (any, error) { return b.Tmux.Capture(a.ID, a.Scrollback) }},
	{Name: "wait_agent", Description: "Wait until an agent is done, then return its screen: until its screen has not changed for quiet_seconds (a working agent's spinner keeps it moving), or until a line holding the text until shows up (one already on screen when the call starts does not count, so the prompt that names it does not either). " +
		"Call it after send_text to get the answer, or to see a question it asks. ready is false when timeout_seconds passed first; call it again to keep waiting.",
		InputSchema: schema([]string{"id"}, map[string]any{"id": idProp,
			"until":           map[string]any{"type": "string", "description": "return as soon as the screen contains this text"},
			"quiet_seconds":   map[string]any{"type": "number", "minimum": 1, "default": defaultQuiet.Seconds()},
			"timeout_seconds": map[string]any{"type": "number", "minimum": 1, "maximum": maxWait.Seconds(), "default": defaultWait.Seconds()}}),
		run: waitAgent},
}

const (
	defaultQuiet = 3 * time.Second
	defaultWait  = 120 * time.Second
	maxWait      = 600 * time.Second // the call blocks every other tool call meanwhile
)

func waitAgent(b Toolbox, a args) (any, error) {
	screen, ready, err := b.Tmux.Wait(a.ID, a.Until, seconds(a.Quiet, defaultQuiet, maxWait), seconds(a.Timeout, defaultWait, maxWait))
	if err != nil {
		return nil, err
	}
	return map[string]any{"ready": ready, "screen": screen}, nil
}

// seconds turns a tool argument into a duration: fallback when absent or
// below a second, capped at most.
func seconds(n float64, fallback, most time.Duration) time.Duration {
	if n < 1 {
		return fallback
	}
	return min(time.Duration(n*float64(time.Second)), most)
}

func (b Toolbox) list() []tool { return tools }

// call runs a tool. A tool's own failure (a missing window, a bad name) is a
// result with isError, so the model reads it and corrects itself; only an
// unknown tool or unreadable arguments are protocol errors.
func (b Toolbox) call(name string, raw json.RawMessage) (any, *rpcError) {
	for _, t := range tools {
		if t.Name != name {
			continue
		}
		var a args
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &a); err != nil {
				return nil, &rpcError{-32602, "invalid arguments: " + err.Error()}
			}
		}
		out, err := t.run(b, a)
		if err != nil {
			return textResult(err.Error(), true), nil
		}
		return textResult(asText(out), false), nil
	}
	return nil, &rpcError{-32602, "unknown tool: " + name}
}

func textResult(text string, isError bool) map[string]any {
	return map[string]any{"content": []map[string]string{{"type": "text", "text": text}}, "isError": isError}
}

func asText(v any) string {
	if s, isString := v.(string); isString {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func ok(err error) (any, error) { return "ok", err }

func idResult(id string, err error) (any, error) { return map[string]string{"id": id}, err }

// Folder paths are stored with \x1f between levels (no name can hold it); "/"
// is what a model can type. shortcut: a folder whose own name has a "/" cannot
// be addressed here; take a separator nobody types if that ever matters.
func toPath(folder string) string { return strings.ReplaceAll(folder, "/", "\x1f") }

func fromPath(path string) string { return strings.ReplaceAll(path, "\x1f", "/") }

type agent struct {
	sessions.Window
	Self bool `json:"self,omitempty"`
}

func listAgents(b Toolbox, _ args) (any, error) {
	windows, err := b.Tmux.List()
	if err != nil {
		return nil, err
	}
	folders, err := b.Tmux.Folders()
	if err != nil {
		return nil, err
	}
	agents := make([]agent, len(windows))
	for i, w := range windows {
		w.Folder = fromPath(w.Folder)
		agents[i] = agent{Window: w, Self: w.ID == b.Self}
	}
	for i, f := range folders {
		folders[i] = fromPath(f)
	}
	return map[string]any{"agents": agents, "folders": folders}, nil
}

func createAgent(b Toolbox, a args) (any, error) {
	if a.Folder != "" {
		if err := folderExists(b, a.Folder); err != nil {
			return nil, err
		}
	}
	id, err := b.Tmux.CreateAt(a.Name, a.Dir)
	if err != nil {
		return nil, err
	}
	if a.Folder != "" {
		if err := b.Tmux.SetFolder(id, toPath(a.Folder)); err != nil {
			return idResult(id, err)
		}
	}
	if a.Command != "" {
		return idResult(id, b.Tmux.SendText(id, a.Command, true))
	}
	return idResult(id, nil)
}

func createFolder(b Toolbox, a args) (any, error) {
	if a.Parent == "" {
		return ok(b.Tmux.AddFolder(a.Name))
	}
	// Folders are made at the top and nested, as the UI does; an existing
	// top-level one of that name would be moved instead of a new one made.
	folders, err := b.Tmux.Folders()
	if err != nil {
		return nil, err
	}
	if slices.Contains(folders, a.Name) {
		return nil, fmt.Errorf("a top-level folder %q exists; create under another name, then rename_folder", a.Name)
	}
	if !slices.Contains(folders, toPath(a.Parent)) {
		return nil, sessions.ErrNoFolder
	}
	if err := b.Tmux.AddFolder(a.Name); err != nil {
		return nil, err
	}
	return ok(b.Tmux.NestFolder(a.Name, toPath(a.Parent)))
}

// folderExists is checked before a create, so a missing folder leaves no
// orphan window behind for a retrying agent to duplicate.
func folderExists(b Toolbox, folder string) error {
	folders, err := b.Tmux.Folders()
	if err != nil {
		return err
	}
	if !slices.Contains(folders, toPath(folder)) {
		return sessions.ErrNoFolder
	}
	return nil
}

func sendText(b Toolbox, a args) (any, error) {
	enter := a.Enter == nil || *a.Enter
	return ok(b.Tmux.SendText(a.ID, a.Text, enter))
}
