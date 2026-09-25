# remotty

Your tmux windows in a browser tab. Built to run 20–30 coding agents on a home
machine and drive them from a tablet while travelling.

- **One binary, no runtime.** Go, with the UI embedded. Nothing is fetched at runtime.
- **Nothing phones home.** No analytics, no telemetry, no auto-update, no third-party
  origin in the page. A test fails if the page ever makes such a request.
- **tmux is the source of truth.** Close the browser and the agents keep running. The
  same windows are one `tmux attach` away over ssh or mosh.
- **Reachable only where you put it.** It listens on loopback; you publish it on your
  private tailnet with `tailscale serve`.

## Quick start

Requires Linux, WSL2 or macOS, tmux 3.2+ (`brew install tmux` on a Mac), and
[Go](https://go.dev/dl/) 1.24+ to build.

```sh
go install github.com/pablowinck/remotty/cmd/remotty@latest
tailscale serve --bg 7681   # HTTPS on your tailnet, private to your devices
remotty serve
```

`remotty serve` finds this machine's tailnet name by itself and prints the URL to
open. On a Mac, the Tailscale app's own CLI is found too, even when `tailscale`
is not on your PATH. To keep it running across reboots and crashes, install it
as a service instead (no root needed; it takes the same flags as `serve`):

```sh
remotty install
```

On Linux that is a systemd user service; run `loginctl enable-linger` to keep it
up while you are logged out. On macOS it is a launchd agent in
`~/Library/LaunchAgents`, started at login, with logs in `~/Library/Logs/remotty.log`.
macOS has no linger: installed over ssh with no one logged in at the Mac, it
runs until logout, and after a reboot it starts only once someone logs in there.
It records your current `PATH`, so run it from the shell whose `tmux` and
`claude` you want the agents to use.

On WSL2, the distro stops once no Windows process holds it open, taking remotty
and tmux with it. Start `wsl.exe -d <distro> --exec dbus-launch true` from the
Windows Startup folder or Task Scheduler to keep it alive. The first `tailscale serve` asks you to enable Serve for your tailnet in the
admin console; that is a one-time click.

Pair a device:

```sh
remotty pair
# (a QR code)
# Pairing code: CBGS5-KOE6K  (valid 5 minutes, one use)
# Or open this link on the device: https://box.tailnet.ts.net/#CBGS5KOE6K
```

Point the phone or tablet camera at the QR code and it pairs by itself. You can
also open the link, or type the code. The code
travels in the URL fragment, which browsers never send to a server.

A paired device stays paired as long as you use it: each use pushes its expiry
30 days ahead. Only a device left unused for 30 days has to pair again.

```sh
remotty devices     # what is paired
remotty revoke ID   # unpair; its open terminals close within a second
```

## Using it

- The left column lists every window of the tmux session `main`. A red dot is a
  bell, amber means the window has been silent for a while (an agent waiting on
  you, if you set `monitor-silence` in tmux), blue is fresh output.
- **Keyboard first.** `Alt+1`…`Alt+9` open agents 1 to 9 (each tab shows its
  chip), `Alt+↓` / `Alt+↑` go to the next or previous one. `Ctrl+Shift+K`
  opens the finder above the list: type to filter by name (or a window
  number), arrows to move, `Enter` to open, and you are typing in that agent.
  None of these keys ever reach the shell. On a Mac, iPad or iPhone keyboard,
  Alt is ⌥ Option and the hints say so (`⌥1`, `⌃⇧K`). If nothing is named exactly that, the last row
  creates a new agent with the name you typed; `Enter` on an empty finder
  creates an unnamed one. `Esc` goes back to the terminal. `+` opens the finder.
- Double-tap a tab to rename it; `×` closes it.
- 📎 attaches a photo or file: it is saved on the host (`~/.local/state/remotty/uploads`,
  private to you) and its path is typed at the prompt, so you can say
  `look at <path>` to the agent. Up to 50 MB; nothing leaves the host. Pick
  several at once, or drop files from the desktop anywhere on the page.
- 🎤 records a voice note: tap to start (the button pulses), tap again to stop.
  It is uploaded like an attachment and its path is typed at the prompt; what
  reads the audio is up to whatever runs in the terminal.
- **Restore** (under the agent list) reopens, one window each, every Claude Code
  conversation touched in the last 2 hours that no process holds anymore — after
  the machine or tmux went down. It runs `claude --resume <id>` in the
  conversation's own directory; change it with `-restore-command` (for example
  `-restore-command "claude --dangerously-skip-permissions --resume"`), or pass
  `-restore-command ""` to hide the button.
- Ctrl+V pastes the viewer's clipboard, as in any desktop terminal. On a Mac, iPad
  or iPhone it is ⌘V, and Ctrl+V stays the terminal's own ^V, as in Terminal.app.
- Drag a tab to reorder the agents (on a touch screen, hold it first so a swipe
  still scrolls), or move the open one with Alt+Shift+↑/↓. The order is tmux's
  own window order, so ssh and every other device see it and Alt+1–9 follow it.
- Drag a finger down on the terminal to scroll back through its history (tmux
  copy mode; `q` leaves it). This needs `set -g mouse on` in `~/.tmux.conf`.
- Drag the mouse over text to copy it to the system clipboard: tmux copies on
  release and sends it out as OSC 52. Programs that copy by themselves (Claude
  Code's copy-on-select, vim) work too: remotty sets tmux `set-clipboard on`.
  The page only ever writes the clipboard; an OSC 52 read request is ignored.
- The bottom bar has the keys a tablet keyboard lacks: Esc, Tab, Enter, a sticky Ctrl,
  arrows, ^C and paste.
- On a phone held upright the page fits the screen exactly: the agents become a
  strip on top (the current one is underlined), `+` creates an agent and the
  magnifier finds one (both open the finder over the whole row), and the keys sit in two rows with no sideways scrolling.
  When the soft keyboard opens, the terminal shrinks to what is left, on iOS too
  (where Safari covers the page instead of resizing it). Tapping a field never
  zooms the page in.
- Install it as an app from the browser menu for full screen.

## Security model

The host usually holds credentials worth more than the terminal itself, so access
is deliberately narrow:

| Threat | Mitigation |
|---|---|
| A page using your devices | `Permissions-Policy` allows the microphone to this page only, for voice notes; camera and location stay off |
| Anyone on the LAN | Listens on `127.0.0.1` only. On WSL2 the Windows side still reaches it through localhost forwarding, which is why every route but pairing requires a paired device |
| Guessing the pairing code | 50-bit one-time code, 5-minute lifetime, burnt after five wrong tries |
| Stolen or leaked device | `remotty revoke` drops it and closes its live terminals |
| A malicious site you visit (CSRF, WebSocket hijacking) | Exact `Origin` allowlist on every write and every WebSocket; `SameSite=Strict` cookie |
| DNS rebinding | `Host` allowlist; anything else gets 421 |
| Injected script via terminal output or window names | Names rendered with `textContent`; enforced CSP with `script-src 'self'` |
| Supply chain | Three small Go dependencies (PTY, WebSocket, QR), xterm.js bundled with its license, no build step |

On `http://localhost` the device cookie cannot be `Secure` (Safari drops it), so
it has another name there and is accepted only for a loopback `Host`.

Only hashes of the pairing code and device tokens are stored, in
`~/.local/state/remotty` with mode 0600. The CSP allows `'unsafe-inline'` for
styles only, because xterm.js injects a `<style>` element.

## Development

```sh
./scripts/check.sh
```

That is the whole gate: `go vet`, unit tests, a build, and a Playwright suite that
drives the real binary in a tablet-sized Chromium against a private tmux server.
It never touches your own tmux or credentials. See [AGENTS.md](AGENTS.md) for the
conventions.

```
cmd/remotty/        the binary: CLI and HTTP wiring
features/access/    pairing, device cookies, the security guard
features/sessions/  tmux windows
features/terminal/  WebSocket <-> PTY bridge
features/uploads/   files from the browser, saved on the host
web/                the UI (plain ES modules, embedded into the binary)
web/features/       UI code for the same three features
e2e/                browser tests
```

## License

MIT. xterm.js is MIT, see `web/lib/xterm/LICENSE`.
