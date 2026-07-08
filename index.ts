/**
 * Llama.cpp Slots Extension
 *
 * Automatically saves llama.cpp slot KV cache to disk at the end of each
 * agent turn and restores it when resuming sessions. Derives the server
 * URL from ctx.model.baseUrl and probes GET /slots to detect capability.
 *
 * Features:
 * - Per-turn slot save (fire-and-forget, non-blocking)
 * - Slot restore on session resume
 * - id_slot injection for deterministic slot routing
 * - KV cache erase on quit (configurable, off by default)
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/llamacpp-slots.ts
 * 2. Ensure your llama.cpp server is started with --slot-save-path /path/to/dir
 *
 * Settings (~/.pi/agent/llama-slots/settings.json):
 * {
 *   "eraseOnQuit": false,        // Erase in-memory KV cache on quit (default: false)
 *   "serverUrl": "http://localhost:4000"  // Override llama.cpp server URL (default: derived from ctx.model.baseUrl)
 * }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── State Interface ──────────────────────────────────────────

interface SlotState {
	/** The llama.cpp slot ID assigned to this session */
	slotId: number;
	/** The session file path (stable Map key) */
	sessionFile: string;
	/** The .bin filename derived from session UUID */
	binFilename: string;
	/** The llama.cpp server base URL */
	serverUrl: string;
}

// ── Settings Interface ───────────────────────────────────────

interface SlotSettings {
	/** Erase in-memory KV cache on session quit. Default: false. */
	eraseOnQuit?: boolean;
	/** Explicit llama.cpp server URL override. When set, bypasses ctx.model.baseUrl derivation. */
	serverUrl?: string;
}

// ── In-Memory State ──────────────────────────────────────────

let slotState: SlotState | null = null;
let slotsActive = false;
let saveController: AbortController | null = null;
let slotVerified = false;  // Whether we've confirmed the slot is warm in this session

// ── Constants ────────────────────────────────────────────────

const SAVE_TIMEOUT_MS = 3000;
const CUSTOM_ENTRY_TYPE = "llamacpp-slot";
const SETTINGS_DIR = path.join(os.homedir(), ".pi", "agent", "llama-slots");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

// ── Settings Helpers ─────────────────────────────────────────

/**
 * Load settings from ~/.pi/agent/llama-slots/settings.json.
 * Returns defaults if the file doesn't exist or is invalid.
 */
function loadSettings(): SlotSettings {
	const defaults: SlotSettings = { eraseOnQuit: false };
	try {
		const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
		const parsed = JSON.parse(raw) as SlotSettings;
		return {
			eraseOnQuit: parsed.eraseOnQuit ?? defaults.eraseOnQuit,
			serverUrl: parsed.serverUrl,
		};
	} catch {
		return defaults;
	}
}

/**
 * Save settings to ~/.pi/agent/llama-slots/settings.json.
 * Creates the directory if it doesn't exist.
 */
function saveSettings(settings: SlotSettings): void {
	try {
		fs.mkdirSync(SETTINGS_DIR, { recursive: true });
		fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
	} catch (err) {
		console.warn("[llamacpp-slots] Failed to save settings:", (err as Error).message);
	}
}

// ── Slot API Helpers ─────────────────────────────────────────

/**
 * Discover available slots by probing GET /slots.
 * Returns the first available slot ID, or the first slot ID if none available.
 * Returns null if the server doesn't support slot management.
 */
async function discoverSlots(serverUrl: string): Promise<number | null> {
	try {
		const response = await fetch(`${serverUrl}/slots`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) return null;

		const data = await response.json();
		if (Array.isArray(data)) {
			for (const slot of data) {
				if (slot.state === "available" || slot.state === "loading") {
					return slot.id;
				}
			}
			// If no available slot, return the first slot ID
			return data[0]?.id ?? null;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Check if a slot's KV cache is cold (empty or nearly empty).
 * A slot is cold when n_prompt_tokens <= 1, meaning llama.cpp
 * restarted and lost its in-memory cache. Returns true if cold,
 * false if warm, null if the check fails.
 */
async function isSlotCold(serverUrl: string, slotId: number): Promise<boolean | null> {
	try {
		const response = await fetch(`${serverUrl}/slots`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) return null;

		const data = await response.json();
		if (Array.isArray(data)) {
			const slot = data.find((s: any) => s.id === slotId);
			if (slot) {
				return (slot.n_prompt_tokens ?? 0) <= 1;
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Save the current slot's KV cache to a .bin file.
 * Fire-and-forget — does not await. Uses a dedicated AbortController
 * with timeout (NOT ctx.signal) to avoid cancellation on user Escape.
 */
function saveSlot(state: SlotState): void {
	// Abort any previous in-flight save to avoid duplicates
	saveController?.abort();

	const controller = new AbortController();
	saveController = controller;
	setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);

	fetch(`${state.serverUrl}/slots/${state.slotId}?action=save`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename: state.binFilename }),
		signal: controller.signal,
	})
		.then(async (res) => {
			if (!res.ok) {
				console.error(`[llamacpp-slots] Save failed: HTTP ${res.status}`);
			}
		})
		.catch((err) => {
			if (err.name !== "AbortError") {
				console.error("[llamacpp-slots] Save error:", err.message);
			}
		});
}

/**
 * Restore a slot's KV cache from a .bin file.
 * Awaited — called during session_start.
 */
async function restoreSlot(state: SlotState): Promise<boolean> {
	try {
		const response = await fetch(
			`${state.serverUrl}/slots/${state.slotId}?action=restore`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename: state.binFilename }),
			},
		);
		if (!response.ok) {
			console.warn(
				`[llamacpp-slots] Restore failed: HTTP ${response.status} (file may not exist)`,
			);
			return false;
		}
		return true;
	} catch (err) {
		console.warn("[llamacpp-slots] Restore error:", (err as Error).message);
		return false;
	}
}

/**
 * Erase a slot's in-memory KV cache.
 * Awaited — called during session_shutdown on quit (when configured).
 */
async function eraseSlot(state: SlotState): Promise<void> {
	try {
		const response = await fetch(
			`${state.serverUrl}/slots/${state.slotId}?action=erase`,
			{
				method: "POST",
			},
		);
		if (!response.ok) {
			console.warn(`[llamacpp-slots] Erase failed: HTTP ${response.status}`);
		}
	} catch (err) {
		// Server may already be shutting down
		console.warn("[llamacpp-slots] Erase error:", (err as Error).message);
	}
}

// ── Persistence ──────────────────────────────────────────────

/**
 * Persist current slot state to session entries.
 * Follows plan-mode/index.ts:108-113 pattern.
 */
function persistSlotState(pi: ExtensionAPI): void {
	if (!slotState) return;
	pi.appendEntry<SlotState>(CUSTOM_ENTRY_TYPE, { ...slotState });
}

/**
 * Restore slot state from session branch entries.
 * Follows tools.ts:52-68 pattern — last entry wins.
 */
function restoreFromBranch(ctx: ExtensionContext): SlotState | null {
	const branchEntries = ctx.sessionManager.getBranch();
	let restored: SlotState | null = null;

	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE) {
			const data = entry.data as SlotState | undefined;
			if (data?.slotId != null && data.sessionFile && data.binFilename && data.serverUrl) {
				restored = data;
			}
		}
	}

	return restored;
}

// ── Slot Filename Derivation ─────────────────────────────────

/**
 * Derive a deterministic .bin filename from the session ID.
 * Uses getSessionId() for a clean UUID-based name.
 */
function deriveBinFilename(sessionId: string): string {
	// Strip hyphens from UUID for a cleaner filename
	const cleanId = sessionId.replace(/-/g, "");
	return `session_${cleanId}.bin`;
}

// ── Extension Factory ────────────────────────────────────────

export default function llamacppSlotsExtension(pi: ExtensionAPI): void {
	console.log("[llamacpp-slots] Extension loaded!");
	// ── Session Start: Discover + Restore ─────────────────────

	pi.on("session_start", async (_event, ctx) => {
		console.log(`[llamacpp-slots] session_start fired, reason=${_event.reason}`);
		// Determine server URL: settings override wins, then fall back to ctx.model.baseUrl
		const settings = loadSettings();
		console.log(`[llamacpp-slots] settings.serverUrl=${settings.serverUrl}, ctx.model.baseUrl=${ctx.model?.baseUrl}`);
		let serverUrl: string | undefined;

		ctx.ui.setStatus("llamacpp-slots", "checking...");

		if (settings.serverUrl) {
			serverUrl = settings.serverUrl.replace(/\/+$/, "");
		} else {
			const model = ctx.model;
			if (model?.baseUrl) {
				serverUrl = model.baseUrl.replace(/\/+$/, "");
			}
		}
		if (!serverUrl) {
			console.log("[llamacpp-slots] No server URL — staying dormant");
			ctx.ui.setStatus("llamacpp-slots", "no server URL");
			return;
		}
		console.log(`[llamacpp-slots] session_start: serverUrl=${serverUrl}`);

		// Step 1: Try to restore persisted slot state from branch
		const restored = restoreFromBranch(ctx);

		if (restored) {
			// We have a saved slot state — check if the slot's cache is still warm
			slotState = restored;
			// Always use the current model's URL (in case server was reconfigured)
			slotState.serverUrl = serverUrl;
			slotsActive = true;

			// Check if the slot is cold (llama.cpp restarted, cache lost)
			const cold = await isSlotCold(serverUrl, restored.slotId);
			if (cold === true) {
				// Slot is cold — restore from .bin
				const ok = await restoreSlot(slotState);
				if (ok) {
					console.log(`[llamacpp-slots] Restored cold slot ${slotState.slotId} from ${slotState.binFilename}`);
					ctx.ui.notify(`llamacpp-slots: restored slot ${slotState.slotId} (was cold)`, "info");
					ctx.ui.setStatus("llamacpp-slots", `slot ${slotState.slotId} restored`);
					slotVerified = true;
				} else {
					console.warn(`[llamacpp-slots] Slot ${slotState.slotId} is cold but restore failed`);
					ctx.ui.notify(`llamacpp-slots: slot ${slotState.slotId} cold, restore failed`, "warning");
					ctx.ui.setStatus("llamacpp-slots", `slot ${slotState.slotId} cold`);
					slotVerified = false; // Will retry on first turn
				}
			} else if (cold === false) {
				// Slot is warm — no restore needed
				console.log(`[llamacpp-slots] Slot ${slotState.slotId} is warm — skipping restore`);
				ctx.ui.setStatus("llamacpp-slots", `slot ${slotState.slotId} warm`);
				slotVerified = true;
			} else {
				// Could not determine — try restore anyway (safe no-op if cache is warm)
				await restoreSlot(slotState);
				console.log(`[llamacpp-slots] Slot ${slotState.slotId} state unknown — restored as fallback`);
				ctx.ui.setStatus("llamacpp-slots", `slot ${slotState.slotId} restored`);
				slotVerified = true; // Best effort
			}
			return;
		}

		// Step 2: No persisted state — discover slots fresh
		const slotId = await discoverSlots(serverUrl);
		if (slotId == null) {
			// Server doesn't support slots or is unreachable — stay dormant
			slotsActive = false;
			ctx.ui.notify("llamacpp-slots: GET /slots failed — staying dormant", "warning");
			ctx.ui.setStatus("llamacpp-slots", "discovery failed");
			return;
		}

		// Step 3: Allocate slot for this session
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionId = ctx.sessionManager.getSessionId();

		if (!sessionFile || !sessionId) {
			// In-memory session without ID — can't derive filename
			slotsActive = false;
			return;
		}

		slotState = {
			slotId,
			sessionFile,
			binFilename: deriveBinFilename(sessionId),
			serverUrl,
		};
		slotsActive = true;
		slotVerified = false; // New slot — verify warmth on first turn

		// Persist the new slot allocation
		persistSlotState(pi);
		ctx.ui.notify(`llamacpp-slots: allocated slot ${slotState.slotId}`, "info");
		ctx.ui.setStatus("llamacpp-slots", `slot ${slotState.slotId} allocated`);
	});

	// ── Session Shutdown: Final Save + Conditional Erase ──────

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!slotState) return;

		// Final save before shutdown — skip on "reload" to avoid overwriting
		// the .bin with incomplete state (turn_end already handles per-turn saves).
		// On reload the agent loop is torn down and the slot may have minimal context.
		if (_event.reason !== "reload") {
			try {
				const response = await fetch(
					`${slotState.serverUrl}/slots/${slotState.slotId}?action=save`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ filename: slotState.binFilename }),
					},
				);
				if (response.ok) {
					console.log(`[llamacpp-slots] Final save: ${slotState.binFilename}`);
				}
			} catch (err) {
				// Server may already be shutting down
				console.warn("[llamacpp-slots] Final save error:", (err as Error).message);
			}
		}

		// Erase in-memory KV cache only on quit AND only if configured
		if (_event.reason === "quit") {
			const settings = loadSettings();
			if (settings.eraseOnQuit) {
				await eraseSlot(slotState);
				console.log("[llamacpp-slots] Erased slot KV cache (eraseOnQuit=true)");
			}
		}

		// Persist final state
		persistSlotState(pi);
	});

	// ── Turn Start: Verify Slot Warmth (mid-session restart safety net) ──

	pi.on("turn_start", async (_event, _ctx) => {
		if (!slotsActive || !slotState || slotVerified) return;
		// Slot hasn't been verified warm yet — check and restore if cold.
		// This handles the case where llama.cpp restarted mid-session
		// (no session_start fired, so isSlotCold wasn't called).
		const cold = await isSlotCold(slotState.serverUrl, slotState.slotId);
		if (cold === true) {
			console.log(`[llamacpp-slots] Slot ${slotState.slotId} is cold on turn_start — restoring`);
			await restoreSlot(slotState);
		} else if (cold === null) {
			// Can't reach server — try restore as fallback
			await restoreSlot(slotState);
		}
		slotVerified = true;
	});

	// ── Turn End: Fire-and-Forget Slot Save ──────────────────

	pi.on("turn_end", async (_event, _ctx) => {
		if (!slotsActive || !slotState) return;
		// Fire-and-forget: do NOT await — saveSlot uses unawaited fetch()
		saveSlot(slotState);
	});

	// ── Before Provider Request: Inject id_slot ──────────────

	pi.on("before_provider_request", (event, ctx) => {
		if (!slotsActive || !slotState) return undefined;
		// Inject id_slot into the provider payload for deterministic slot routing.
		// The OpenAI SDK's FallbackEncoder JSON.stringifies the full body —
		// custom fields like id_slot survive to the HTTP request.
		const payload = event.payload as Record<string, unknown>;
		return {
			...payload,
			id_slot: slotState.slotId,
		};
	});
}
