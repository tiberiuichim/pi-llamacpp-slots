# pi-llamacpp-slots

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that automatically saves and restores llama.cpp slot KV cache across sessions. Keeps your conversation context warm — no re-prompting on resume.

## Features

- **Auto-save** — Saves slot KV cache to disk at the end of each agent turn (fire-and-forget, non-blocking)
- **Auto-restore** — Restores the saved slot when resuming a session
- **Deterministic routing** — Injects `id_slot` into provider requests so all requests hit the same slot
- **Erase on quit** — Optionally clears the in-memory KV cache when you quit (off by default)
- **Zero config** — Auto-detects llama.cpp via `GET /slots` probe; derive server URL from your provider settings

## Requirements

- llama.cpp server started with `--slots` and `--slot-save-path /path/to/dir`
- pi ≥ 0.80 (for `appendEntry` / `getBranch` session persistence)

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
pi starts
  │
  ├─► session_start
  │   ├─► Load settings
  │   ├─► Restore slot state from session branch (if exists)
  │   │   └─► POST /slots/{id}?action=restore  ← restore KV cache from .bin
  │   └─► Or: discover fresh slot
  │       └─► GET /slots  ← probe llama.cpp capability
  │
  ├─► before_provider_request
  │   └─► Inject id_slot into payload  ← deterministic slot routing
  │
  ├─► turn_end (after each agent turn)
  │   └─► POST /slots/{id}?action=save  ← fire-and-forget, 3s timeout
  │
  └─► session_shutdown
      ├─► POST /slots/{id}?action=save  ← final save (awaited)
      └─► POST /slots/{id}?action=erase  ← only on quit + eraseOnQuit=true
```

### Slot filenames

Each session gets a deterministic `.bin` filename derived from its UUID:

```
session_<uuid-no-hyphens>.bin
```

Files are stored in your llama.cpp `--slot-save-path` directory.

### Performance

- Slot saves are fire-and-forget with a 3-second timeout — never block the agent loop
- `GET /slots` probe at startup adds ~50ms
- Slot restore at session start adds ~50-100ms on resume
- `id_slot` injection is synchronous and trivial

## Development

```bash
# Install dependencies (for TypeScript type checking)
npm install

# Type check
npx tsc --noEmit
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti) — no compilation needed. Edit `index.ts`, then `/reload` in pi to hot-reload.

## Troubleshooting

### Extension stays dormant

Check the pi footer status bar for `llamacpp-slots: ...`. Possible states:

| Status | Cause | Fix |
|--------|-------|-----|
| `no server URL` | No `serverUrl` in settings and no `ctx.model.baseUrl` | Set `serverUrl` in settings or configure a provider |
| `discovery failed` | `GET /slots` returned non-200 or timed out | Verify llama.cpp is running with `--slots` flag |
| *(no status)* | Extension failed to load | Check for TypeScript errors: `npx tsc --noEmit` |

### Proxying through litellm

litellm doesn't proxy `/slots` requests. Set `serverUrl` in settings to point directly at llama.cpp:

```json
{
  "serverUrl": "http://localhost:4000"
}
```

### No .bin files appearing

Verify llama.cpp is started with `--slot-save-path /path/to/dir` and that the directory is writable.

## License

ISC
