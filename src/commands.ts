import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@mariozechner/pi-tui";
import { getRefDir, listEntries, ensureRefDir, isGitRepo, runGit } from "./helpers";
import { generateIndex } from "./index-gen";
import { listCache, updateCacheEntry, updateAllCache, removeCacheEntry, clearCache, getCacheSize } from "./cache";
import { addRepo, addFile, removeEntry } from "./entries";
import { CACHE_DIR, INDEX_FILE, SIDECAR_DIR } from "./constants";
import { readSidecar, updateSidecarField, listSidecars, createSidecar, type SidecarFrontmatter } from "./sidecar";
import { setCacheDescription } from "./cache-meta";

// ─── Types ───────────────────────────────────────────────────────────

/** Shared mutable state from the extension entry point. */
export interface RefState {
	refInitialized: boolean;
	indexContent: string | null;
}

// ─── Subcommand definitions ──────────────────────────────────────────

export const SUBCOMMANDS: readonly { name: string; description: string; takesEntry?: boolean; takesCache?: boolean }[] = [
	{ name: "init", description: "Create REFERENCE/ dir and git exclude" },
	{ name: "list", description: "Show entries in REFERENCE/" },
	{ name: "add", description: "Clone repo or copy file/dir into REFERENCE/" },
	{ name: "remove", description: "Remove an entry from REFERENCE/", takesEntry: true },
	{ name: "index", description: "Regenerate REFERENCE_INDEX.md" },
	{ name: "describe", description: "Set description for an entry (syncs to cache)", takesEntry: true },
	{ name: "relevance", description: "Set project relevance for an entry", takesEntry: true },
	{ name: "cache", description: "Manage the clone cache (~/.pi/reference/cache/)" },
];

const CACHE_SUBCOMMANDS: readonly { name: string; description: string; takesCacheEntry?: boolean }[] = [
	{ name: "list", description: "Show cached repos" },
	{ name: "update", description: "Pull latest for all (or one) cached repos", takesCacheEntry: true },
	{ name: "remove", description: "Remove a repo from cache", takesCacheEntry: true },
	{ name: "clear", description: "Clear the entire cache" },
];

// ─── Autocomplete ────────────────────────────────────────────────────

/** Stored context ref so autocomplete can query current entries without a ctx arg. */
let autocompleteCwd: string | undefined;

export function setAutocompleteCwd(cwd: string | undefined) {
	autocompleteCwd = cwd;
}

function subcommandSuggestions(partial: string): AutocompleteItem[] {
	const filtered = fuzzyFilter([...SUBCOMMANDS], partial, (s) => s.name);
	if (filtered.length === 0) return [];
	return filtered.map((s) => ({
		value: `${s.name} `,
		label: s.name,
		description: s.description,
	}));
}

function entrySuggestions(subcmd: string, partial: string): AutocompleteItem[] {
	if (!autocompleteCwd) return [];
	const entries = listEntries(autocompleteCwd);
	const filtered = fuzzyFilter(entries, partial, (e) => e);
	if (filtered.length === 0) return [];
	return filtered.map((e) => ({
		value: `${subcmd} ${e}`,
		label: e,
		description: "Reference entry",
	}));
}

function cacheEntrySuggestions(cacheSub: string, partial: string): AutocompleteItem[] {
	const entries = listCache();
	const filtered = fuzzyFilter(entries, partial, (e) => e.name);
	if (filtered.length === 0) return [];
	return filtered.map((e) => ({
		value: `cache ${cacheSub} ${e.name}`,
		label: e.name,
		description: `${e.size}${e.isGit ? ` — ${e.remote || "git"}` : ""}`,
	}));
}

function cacheSubcommandSuggestions(partial: string): AutocompleteItem[] {
	const filtered = fuzzyFilter([...CACHE_SUBCOMMANDS], partial, (s) => s.name);
	if (filtered.length === 0) return [];
	return filtered.map((s) => ({
		value: `${s.name} `,
		label: s.name,
		description: s.description,
	}));
}

/**
 * Rich argument autocomplete for `/reference ...`.
 */
export function getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const trimmedStart = argumentPrefix.trimStart();
	const spaceIdx = trimmedStart.search(/\s/);
	const firstRaw = spaceIdx === -1 ? trimmedStart : trimmedStart.slice(0, spaceIdx);
	const tail = spaceIdx === -1 ? "" : trimmedStart.slice(spaceIdx + 1).trimStart();

	if (!firstRaw) return subcommandSuggestions("");

	const sub = SUBCOMMANDS.find((s) => s.name === firstRaw);

	if (!sub) {
		const subs = subcommandSuggestions(firstRaw);
		return subs.length ? subs : null;
	}

	if (sub.name === "cache") {
		if (!tail) return cacheSubcommandSuggestions("");

		const cacheSpaceIdx = tail.search(/\s/);
		const cacheSubRaw = cacheSpaceIdx === -1 ? tail : tail.slice(0, cacheSpaceIdx);
		const cacheTail = cacheSpaceIdx === -1 ? "" : tail.slice(cacheSpaceIdx + 1).trimStart();

		const cacheSub = CACHE_SUBCOMMANDS.find((s) => s.name === cacheSubRaw);

		if (!cacheSub) {
			const items = cacheSubcommandSuggestions(cacheSubRaw);
			return items.length ? items : null;
		}

		if (cacheSub.takesCacheEntry && cacheTail !== undefined) {
			const items = cacheEntrySuggestions(cacheSub.name, cacheTail);
			return items.length ? items : null;
		}

		return null;
	}

	if (sub.takesEntry && tail !== undefined) {
		const items = entrySuggestions(sub.name, tail);
		return items.length ? items : null;
	}

	return null;
}

// ─── Overlay helpers ─────────────────────────────────────────────────

/** Show text in a centered overlay panel. */
async function showPanel(ctx: ExtensionContext, title: string, body: string, width = 72): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(body, "info");
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => {
			return {
				render(w: number): string[] {
					const panelWidth = Math.min(width, w - 4);
					const lines: string[] = [];
					lines.push("");
					lines.push(theme.fg("accent", ` ${title} `));
					lines.push(theme.fg("borderMuted", "─".repeat(panelWidth)));
					for (const line of body.split("\n")) {
						lines.push(theme.fg("text", line));
					}
					lines.push("");
					lines.push(theme.fg("dim", "Press Escape to close"));
					lines.push("");
					return lines;
				},
				handleInput(data: string) {
					if (data === "\x1b" || data === "\x03") {
						done();
					}
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width } },
	);
}

// ─── Arg parsing ─────────────────────────────────────────────────────

export function parseArgs(raw: string): { cmd: string; rest: string } {
	const s = raw.trim();
	if (!s) return { cmd: "", rest: "" };
	const i = s.indexOf(" ");
	return i === -1 ? { cmd: s, rest: "" } : { cmd: s.slice(0, i), rest: s.slice(i + 1).trim() };
}

// ─── Command handlers ────────────────────────────────────────────────

export async function handleHelp(ctx: ExtensionContext) {
	await showPanel(
		ctx,
		"/reference — manage REFERENCE/ directory",
		[
			"  init                    Create REFERENCE/ dir and git exclude",
			"  list                    Show entries in REFERENCE/",
			"  add <url|path> [--as N] Clone repo or copy file/dir into REFERENCE/",
			"  remove <name>           Remove an entry from REFERENCE/",
			"  index                   Regenerate REFERENCE_INDEX.md",
			"  describe <name> <text>  Set description (syncs to cache)",
			"  relevance <name> <text> Set project relevance (local only)",
			"",
			"  cache list              Show cached repos (~/.pi/reference/cache/)",
			"  cache update [name]     Pull latest for cached repos (or one repo)",
			"  cache remove <name>     Remove a repo from the cache",
			"  cache clear             Clear the entire cache",
		].join("\n"),
		60,
	);
}

export async function handleInit(ctx: ExtensionContext, state: RefState) {
	const created = await ensureRefDir(ctx.cwd);

	// Create sidecars for any entries that don't have one yet
	const existingSidecars = new Set(listSidecars(ctx.cwd));
	const entries = fs
		.readdirSync(getRefDir(ctx.cwd), { withFileTypes: true })
		.filter((e) => e.name !== INDEX_FILE && e.name !== ".git" && e.name !== SIDECAR_DIR && !existingSidecars.has(e.name));

	let migrated = 0;
	for (const entry of entries) {
		const entryPath = path.join(getRefDir(ctx.cwd), entry.name);
		const isDir = fs.statSync(entryPath).isDirectory(); // follows symlinks
		let type: "git" | "directory" | "file" = isDir ? "directory" : "file";
		let remote: string | undefined;

		if (isDir && isGitRepo(entryPath)) {
			type = "git";
			const result = runGit(["remote", "get-url", "origin"], entryPath);
			if (result.code === 0) remote = result.stdout;
		}

		const fm: SidecarFrontmatter = { entry: entry.name, type, remote };
		await createSidecar(ctx.cwd, entry.name, fm);
		migrated++;
	}

	state.indexContent = await generateIndex(ctx.cwd);
	state.refInitialized = true;

	const parts: string[] = [];
	if (created) {
		parts.push("✓ Created REFERENCE/ directory and added to .git/info/exclude");
	}
	if (migrated > 0) {
		parts.push(`✓ Created sidecars for ${migrated} existing ${migrated === 1 ? "entry" : "entries"}`);
	}
	if (parts.length === 0) {
		parts.push("✓ REFERENCE/ directory already initialized. Index refreshed.");
	}
	ctx.ui.notify(parts.join("\n"), "info");
}

export async function handleList(ctx: ExtensionContext, state: RefState) {
	const refDir = getRefDir(ctx.cwd);
	if (!fs.existsSync(refDir)) {
		ctx.ui.notify("REFERENCE/ does not exist. Run /reference init first.", "warning");
		return;
	}

	// Generate fresh manifest from sidecars
	state.indexContent = await generateIndex(ctx.cwd);
	ctx.ui.notify(state.indexContent, "info");
}

export async function handleAdd(ctx: ExtensionContext, input: string, state: RefState) {
	if (!input) {
		ctx.ui.notify("Usage: /reference add <git-url-or-local-path> [--as name]", "warning");
		return;
	}

	await ensureRefDir(ctx.cwd);

	let name: string | undefined;
	let target = input;
	const nameMatch = input.match(/^(.+?)\s+--as\s+(\S+)$/);
	if (nameMatch) {
		target = nameMatch[1];
		name = nameMatch[2];
	}

	let result: { success: boolean; message: string };

	if (
		target.startsWith("http://") ||
		target.startsWith("https://") ||
		target.startsWith("git@") ||
		target.startsWith("ssh://")
	) {
		result = await addRepo(ctx.cwd, target, name);
	} else if (target.startsWith("git:")) {
		const url = target.startsWith("git://") ? target : `https://github.com/${target.slice(4)}`;
		result = await addRepo(ctx.cwd, url, name);
	} else {
		result = await addFile(ctx.cwd, target, name);
	}

	if (result.success) {
		state.indexContent = await generateIndex(ctx.cwd);
		ctx.ui.notify(`✓ ${result.message}`, "info");
	} else {
		ctx.ui.notify(`✗ ${result.message}`, "error");
	}
}

export async function handleRemove(ctx: ExtensionContext, name: string, state: RefState) {
	if (!name) {
		ctx.ui.notify("Usage: /reference remove <name>", "warning");
		return;
	}

	const result = await removeEntry(ctx.cwd, name);
	if (result.success) {
		state.indexContent = await generateIndex(ctx.cwd);
		ctx.ui.notify(`✓ ${result.message}`, "info");
	} else {
		ctx.ui.notify(`✗ ${result.message}`, "error");
	}
}

export async function handleIndex(ctx: ExtensionContext, state: RefState) {
	state.indexContent = await generateIndex(ctx.cwd);
	ctx.ui.notify("✓ Reference index regenerated", "info");
}

export async function handleDescribe(ctx: ExtensionContext, name: string, text: string, state: RefState) {
	if (!name || !text) {
		const entries = listEntries(ctx.cwd);
		ctx.ui.notify(
			`Usage: /reference describe <name> <text>\nAvailable entries: ${entries.join(", ") || "(empty)"}`,
			"info",
		);
		return;
	}
	if (!listEntries(ctx.cwd).includes(name)) {
		ctx.ui.notify(`Entry '${name}' not found in REFERENCE/`, "error");
		return;
	}

	// Write-through: update sidecar AND cache-meta
	await updateSidecarField(ctx.cwd, name, { description: text });

	const sidecar = await readSidecar(ctx.cwd, name);
	if (sidecar?.frontmatter.type === "git" && sidecar.frontmatter.remote) {
		await setCacheDescription(name, text);
	}

	state.indexContent = await generateIndex(ctx.cwd);
	ctx.ui.notify(`✓ Description set for ${name}`, "info");
}

export async function handleRelevance(ctx: ExtensionContext, name: string, text: string, state: RefState) {
	if (!name || !text) {
		const entries = listEntries(ctx.cwd);
		ctx.ui.notify(
			`Usage: /reference relevance <name> <text>\nAvailable entries: ${entries.join(", ") || "(empty)"}`,
			"info",
		);
		return;
	}
	if (!listEntries(ctx.cwd).includes(name)) {
		ctx.ui.notify(`Entry '${name}' not found in REFERENCE/`, "error");
		return;
	}

	// Sidecar only — project-local, does not sync to cache
	await updateSidecarField(ctx.cwd, name, { relevance: text });
	state.indexContent = await generateIndex(ctx.cwd);
	ctx.ui.notify(`✓ Project relevance set for ${name}`, "info");
}

export async function handleCache(ctx: ExtensionContext, sub: string, rest: string, state: RefState) {
	switch (sub) {
		case "list": {
			const entries = listCache();
			if (entries.length === 0) {
				ctx.ui.notify(`Cache is empty (${CACHE_DIR})`, "info");
				return;
			}
			const totalSize = getCacheSize();
			const body = [
				`Cache location: ${CACHE_DIR}`,
				`Total size: ${totalSize}`,
				"",
				...entries.map(
					(e) => `${e.name}  ${e.size}${e.isGit ? `  (${e.remote || "no remote"})` : ""}`,
				),
			].join("\n");

			await showPanel(ctx, "Reference Cache", body, 80);
			break;
		}

		case "update": {
			if (rest) {
				const r = await updateCacheEntry(rest);
				ctx.ui.notify(r.success ? `✓ ${r.message}` : `✗ ${r.message}`, r.success ? "info" : "error");
			} else {
				const results = await updateAllCache();
				ctx.ui.notify(`✓ Cache update:\n${results.join("\n")}`, "info");
			}
			if (state.refInitialized) {
				state.indexContent = await generateIndex(ctx.cwd);
			}
			break;
		}

		case "remove": {
			if (!rest) {
				ctx.ui.notify("Usage: /reference cache remove <name>", "warning");
				return;
			}
			const r = await removeCacheEntry(rest);
			ctx.ui.notify(r.success ? `✓ ${r.message}` : `✗ ${r.message}`, r.success ? "info" : "error");
			break;
		}

		case "clear": {
			const result = await clearCache();
			ctx.ui.notify(`✓ Cleared cache: removed ${result.removed} entries, freed ${result.freed}`, "info");
			break;
		}

		default:
			await showPanel(
				ctx,
				"/reference cache",
				[
					"  list              Show cached repos",
					"  update [name]     Pull latest for all (or one) cached repos",
					"  remove <name>     Remove a repo from cache",
					"  clear             Clear the entire cache",
				].join("\n"),
				52,
			);
	}
}
