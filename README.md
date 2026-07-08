# pi-llamacpp-slots

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that automatically saves and restores llama.cpp slot KV cache across sessions. Keeps your conversation context warm — no re-prompting on resume.

## Features

- **Auto-save** — Saves slot KV cache to disk at the end of each agent turn (fire-and-forget, non-blocking)
- **Smart restore** — Detects cold slots (llama.cpp restart) and restores only when needed
- **Mid-session recovery** — Survives llama.cpp restarts without requiring pi `/reload`
- **Deterministic routing** — Injects `id_slot` into provider requests so all requests hit the same slot
- **Erase on quit** — Optionally clears the in-memory KV cache when you quit (off by default)
- **Zero config** — Auto-detects llama.cpp via `GET /slots` probe; derive server URL from your provider settings

## Requirements

- llama.cpp server started with `--slots` and `--slot-save-path /path/to/dir`
- pi >= 0.80 (for `appendEntry` / `getBranch` session persistence)

## Installation

### Quick install (symlink)

```bash
# Clone or copy this repo somewhere
git clone <repo> ~/pi-llamacpp-slots

# Symlink into pi's global extensions directory
ln -sfn ~/pi-llamacpp-slots ~/.pi/agent/extensions/llamacpp-slots
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts` and hot-reloads on `/reload`.

### Manual install

Copy `index.ts` to `~/.pi/agent/extensions/llamacpp-slots.ts`.

## Configuration

Optional settings file at `~/.pi/agent/llama-slots/settings.json`:

```json
{
  "eraseOnQuit": false,
  "serverUrl": "http://localhost:4000"
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `eraseOnQuit` | `boolean` | `false` | Erase in-memory KV cache on quit. Keep `false` to preserve warm cache across restarts. |
| `serverUrl` | `string` | *(derived)* | Override the llama.cpp server URL. By default, derived from `ctx.model.baseUrl`. Set this when proxying through litellm or another reverse proxy. |

### Server URL resolution

The extension resolves the llama.cpp server URL in this order:

1. `serverUrl` from `~/.pi/agent/llama-slots/settings.json` (if set)
2. `ctx.model.baseUrl` from your current pi provider configuration
3. If neither is available, the extension stays dormant

If you're proxying through **litellm** or another reverse proxy that doesn't forward `/slots` requests, set `serverUrl` to point directly at your llama.cpp server.

## How It Works

```
pi starts / reloads
  │
  ├─► session_start
  │   ├─► Load settings
  │   ├─► Restore slot state from session branch (if exists)
  │   │   └─► GET /slots → verify server reachable (no restore yet)
  │   └─► Or: discover fresh slot
  │       └─► GET /slots  ← probe llama.cpp capability
  │
  ├─► turn_start (every turn)
  │   ├─► GET /slots → check slot state
  │   ├─► processing → skip restore (avoid interference)
  │   ├─► first turn → always restore (n_prompt_tokens unreliable after reload)
  │   ├─► tokens > 0 → skip restore (slot is warm)
  │   └─► tokens == 0 → POST /slots/{id}?action=restore + await
  │       (loads KV cache from .bin after mid-session llama.cpp restart)
  │
  ├─► before_provider_request (every request)
  │   ├─► Wait for in-flight restore (if any)  ← prevents race with turn_start
  │   └─► Inject id_slot into payload  ← deterministic slot routing
  │
  ├─► turn_end (after each agent turn)
  │   └─► POST /slots/{id}?action=save  ← fire-and-forget, 3s timeout
  │
  └─► session_shutdown
      ├─► POST /slots/{id}?action=save  ← final save (skipped on /reload)
      └─► POST /slots/{id}?action=erase  ← only on quit + eraseOnQuit=true
```

### Llama.cpp restart scenarios

| Scenario | What happens |
|----------|--------------|
| Restart llama.cpp, then `/reload` in pi | `turn_start` restores from `.bin` before first request |
| Restart llama.cpp, type prompt (no `/reload`) | `turn_start` restores from `.bin` before first request |
| Restart llama.cpp + pi together | `turn_start` restores from `.bin` before first request |

Restore always happens in `turn_start` (not `session_start`) because that's when llama.cpp is guaranteed to be fully loaded and ready.

### Slot filenames

Each session gets a deterministic `.bin` filename derived from its UUID:

```
session_<uuid-no-hyphens>.bin
```

Files are stored in your llama.cpp `--slot-save-path` directory.

### Performance

- Slot saves are fire-and-forget with a 3-second timeout — never block the agent loop
- `GET /slots` probe at startup adds ~50ms
- Restore check on every turn: GET /slots (~50ms)
- Actual restore on first turn: POST restore (~10-100ms, reads .bin and loads KV cache)
- Subsequent turns skip restore when slot is warm (no disk I/O)
- `id_slot` injection is synchronous and trivial

## Debug Log

All extension events are logged to `~/.pi/agent/llama-slots/debug.log` (append-only, ISO timestamps). Footer status messages are disabled — use the log file to monitor the extension:

```bash
tail -f ~/.pi/agent/llama-slots/debug.log
```

## Development

```bash
# Install dependencies (for TypeScript type checking)
npm install

# Type check
npm run check
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti) — no compilation needed. Edit `index.ts`, then `/reload` in pi to hot-reload.

## Troubleshooting

### Extension stays dormant

Check the debug log for clues:

| Log message | Cause | Fix |
|-------------|-------|-----|
| `No server URL — staying dormant` | No `serverUrl` in settings and no `ctx.model.baseUrl` | Set `serverUrl` in settings or configure a provider |
| `GET /slots failed — staying dormant` | `GET /slots` returned non-200 or timed out | Verify llama.cpp is running with `--slots` flag |
| *(no log at all)* | Extension failed to load | Check for TypeScript errors: `npx tsc --noEmit` |

### Proxying through litellm

litellm doesn't proxy `/slots` requests. Set `serverUrl` in settings to point directly at llama.cpp:

```json
{
  "serverUrl": "http://localhost:4000"
}
```

### No .bin files appearing

Verify llama.cpp is started with `--slot-save-path /path/to/dir` and that the directory is writable.

### Cache lost after `/reload`

As of v1.0.1, `/reload` no longer triggers a save (which could overwrite the `.bin` with incomplete state). Per-turn saves via `turn_end` are the authoritative source.

### Restore messages in the logs

You'll see messages like these:

```
[llamacpp-slots] Slot 0 first turn — restoring
[llamacpp-slots] Restored slot 0 from session_....bin
[llamacpp-slots] Slot 0 warm (n_prompt_tokens=55526) — skipping restore
[llamacpp-slots] Slot 0 cold (n_prompt_tokens=0) — restoring
```

- **"first turn — restoring"** appears on the first turn after pi starts or reloads. The restore ensures the KV cache is loaded, since `n_prompt_tokens` can be missing from `GET /slots` even on warm slots (it's only reported when the slot has an active or previous task).
- **"warm — skipping restore"** means the slot already has tokens — no disk I/O.
- **"cold — restoring"** appears after a mid-session llama.cpp restart. This is rare and only happens if you restart llama.cpp without reloading pi.

## License

ISC
