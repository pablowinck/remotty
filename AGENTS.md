# Working on remotty

## Commands

```sh
./scripts/check.sh                 # everything: vet, unit tests, build, browser tests
./scripts/check.sh --e2e -g "Enter"  # rebuild, then only the matching browser tests
go test ./features/access/         # one Go package
```

A change is done when `./scripts/check.sh` ends with `== all green`. It needs
`go`, `node` and `tmux`, and no sudo: Playwright downloads its own Chromium
and WebKit (Safari's engine, for `e2e/ios.spec.js`). It runs on Linux and macOS.
On Linux WebKit also needs system libraries (`sudo npx --prefix e2e playwright
install-deps webkit`); without them the check skips `ios.spec.js` and says so.
Touching iOS code? Run it where WebKit starts.
`--e2e` skips vet and unit tests for a fast loop; extra arguments go to
Playwright. Run the full check before you call it done.

## Where things go

The code is organised by feature, the same three on each side:

| feature | Go (server) | UI | browser tests |
|---|---|---|---|
| pairing, cookies, security guard | `features/access/` | `web/features/access.js` | `e2e/access.spec.js` |
| tmux windows (tabs) | `features/sessions/` | `web/features/sessions.js` | `e2e/sessions.spec.js` |
| the terminal itself | `features/terminal/` | `web/features/terminal.js` | `e2e/terminal.spec.js` |
| attachments | `features/uploads/` | `web/features/uploads.js` | `e2e/uploads.spec.js` |

`cmd/remotty` only parses flags and wires features together. `e2e/resilience.spec.js`
covers restarts and dropped connections; `e2e/fixtures.js` holds the helpers
(`pair`, `typeInTerminal`, `host.capture`, `host.tmux`).

- **Extending a feature** (a key on the key bar, a field on a window): edit the
  files of that feature only. Most UI changes need no Go at all.
- **A new feature**: add the same three places, plus a route in the feature's
  own Go package, registered from `cmd/remotty/serve.go`.
- **User-visible behaviour**: update the "Using it" section of the README.

## Rules

- **No request may leave the page's origin.** No CDN, font service, analytics or
  update check. The e2e `page` fixture fails any test that tries.
- **Never write untrusted text as HTML.** Window names and terminal titles are set
  by programs inside the terminal. Use `textContent`.
- **Every route but pairing goes through `RequireDevice`.** Every state change and
  every WebSocket goes through the Origin check in `Guard.Wrap`.
- **Bytes sent to the terminal are what a real keyboard sends**: Enter is `\r`,
  Ctrl+X is the letter's code minus 64, arrows are `\x1b[A`..`\x1b[D`.
- **No new dependency** for what a few lines of stdlib do.

## Every test must be seen failing

A test counts only after you have watched it fail: break the code it covers,
run it, see it red, restore. This applies to every test, not only security ones.
Use a copy, not `git checkout`, to restore, or you will also undo your own change:

```sh
cp web/features/terminal.js /tmp/keep.js    # save
# ...break it, run the test, see red...
cp /tmp/keep.js web/features/terminal.js    # restore
```

A negative assertion ("was refused", "does not contain") also needs a positive
anchor next to it, so a dead server cannot pass it. Prove terminal behaviour on
both sides: what xterm shows (`#terminal .xterm-rows`) and what tmux holds
(`host.capture(windowId)`). And make the expected text something only execution
produces, like `$((3*5))` turning into `15`, because the shell echoes what you type.

## Tests never touch the real world

The e2e fixture gives each test its own tmux socket, state dir, `HOME` and port.
Go tests use `t.TempDir()`. Keep it that way: a test that reads your real tmux
or `~/.local/state/remotty` is a bug.
