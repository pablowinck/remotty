// Package mcp lets an agent drive remotty's windows over the Model Context
// Protocol: one JSON-RPC 2.0 message per line on stdin/stdout, which is all an
// MCP stdio server is, so it needs no SDK.
package mcp

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
)

const latestProtocol = "2025-06-18"

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"` // absent on a notification
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Serve answers requests from in on out until in ends. Only out carries the
// protocol: anything else written to stdout would corrupt the stream.
func Serve(in io.Reader, out io.Writer, tools Toolbox) error {
	reader := bufio.NewReader(in) // not a Scanner: its line limit would cap send_text
	enc := json.NewEncoder(out)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if resp := handleLine(line, tools); resp != nil {
				if werr := enc.Encode(resp); werr != nil {
					return werr
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func handleLine(line []byte, tools Toolbox) *response {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return &response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}}
	}
	if req.ID == nil {
		return nil // notifications (initialized, cancelled) want no answer
	}
	result, rerr := dispatch(req, tools)
	return &response{JSONRPC: "2.0", ID: req.ID, Result: result, Error: rerr}
}

func dispatch(req request, tools Toolbox) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		return initialize(req.Params), nil
	case "ping":
		return struct{}{}, nil
	case "tools/list":
		return map[string]any{"tools": tools.list()}, nil
	case "tools/call":
		var call struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &call); err != nil {
			return nil, &rpcError{-32602, "invalid params"}
		}
		return tools.call(call.Name, call.Arguments)
	}
	return nil, &rpcError{-32601, "method not found: " + req.Method}
}

// initialize agrees to the client's protocol version: the few methods served
// here are the same in every version so far.
func initialize(params json.RawMessage) map[string]any {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	json.Unmarshal(params, &p)
	version := p.ProtocolVersion
	if version == "" {
		version = latestProtocol
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]string{"name": "remotty", "version": "1"},
		"instructions":    instructions,
	}
}

const instructions = `Drives the tmux windows remotty shows as agent tabs. Call list_agents first: ids look like "@3", and the window you run in is marked self. ` +
	`To talk to another agent, send_text it a prompt, then wait_agent: it returns the screen once the agent is done. ` +
	`To answer a menu or a question (Claude Code's multiple choice), read the options on that screen (or read_screen), then send_keys (a digit, or Up/Down then Enter). ` +
	`Folders nest; a path like "jobs/seo" is the folder seo inside jobs.`
