import * as fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getRefDir, listReferenceTree, listEntries } from "./helpers";
import { generateIndex, setEntryMetadata } from "./index-gen";
import { ensureRefDir } from "./helpers";
import { listCache, updateCacheEntry, updateAllCache, removeCacheEntry, clearCache, getCacheSize } from "./cache";
import { addRepo, addFile, removeEntry } from "./entries";
import { CACHE_DIR } from "./constants";

// ─── Command handler types ───────────────────────────────────────────

// Shared mutable state from the extension entry point
export interface RefState {
	refInitialized: boolean;
	indexContent: string | null;
}

// ─── Command handlers ────────────────────────────────────────────────

export async function handleInit(ctx: ExtensionContext, state: RefState) {
	const created = await ensureRefDir(ctx.cwd);
	state.indexContent = await generateIndex(ctx.cwd);
	state.refInitialized = true;

	if (created) {
		ctx.ui.notify("✓ Created REFERENCE/ directory and added to .git/info/exclude", "info");
	} else {
		ctx.ui.notify("✓ REFERENCE/ directory already exists. Index refreshed.", "info");
	}
}

export async function handleList(ctx: ExtensionContext, depthArg: string) {
	const refDir = getRefDir(ctx.cwd);
	if (!fs.existsSync(refDir)) {
		ctx.ui.notify("REFERENCE/ does not exist. Run /reference init first.", "warning");
		return;
	}

	const depth = depthArg ? parseInt(depthArg, 10) : Infinity;
	if (isNaN(depth) || depth < 0) {
		ctx.ui.notify("Depth must be a non-negative number", "warning");
		return;
	}
	const tree = listReferenceTree(ctx.cwd, depth);

	if (!ctx.hasUI) {
		ctx.ui.notify(tree, "info");
		return;
	}

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		return {
			render(width: number): string[] {
				const lines: string[] = [];
				lines.push("");
				lines.push(theme.fg("accent", ` REFERENCE/ Contents (depth ${depth === Infinity ? "full" : depth}) `));
				lines.push(theme.fg("borderMuted", "─".repeat(width)));
				for (const line of tree.split("\n")) {
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
	});
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

export async function handleIndex(ctx: ExtensionContext, subarg: string, state: RefState) {
	if (!subarg || subarg === "update" || subarg === "regenerate") {
		state.indexContent = await generateIndex(ctx.cwd);
		ctx.ui.notify("✓ Reference index regenerated", "info");
	} else {
		const entries = listEntries(ctx.cwd);
		if (!entries.includes(subarg)) {
			ctx.ui.notify(`Entry '${subarg}' not found. Available: ${entries.join(", ") || "(empty)"}`, "warning");
			return;
		}
		state.indexContent = await generateIndex(ctx.cwd);
		ctx.ui.notify(`✓ Reference index refreshed (entry: ${subarg})`, "info");
	}
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
	state.indexContent = await setEntryMetadata(ctx.cwd, name, "description", text);
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
	state.indexContent = await setEntryMetadata(ctx.cwd, name, "relevance", text);
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
			const lines = entries.map(
				(e) => `  ${e.name} — ${e.size}${e.isGit ? ` (git: ${e.remote || "no remote"})` : ""}`,
			);
			ctx.ui.notify(`Cache (${totalSize} total, ${CACHE_DIR}):\n${lines.join("\n")}`, "info");
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
			ctx.ui.notify(
				"Usage: /reference cache <list|update|remove|clear>\n" +
				"  list              Show cached repos\n" +
				"  update [name]     Pull latest for all (or one) cached repos\n" +
				"  remove <name>     Remove a repo from cache\n" +
				"  clear             Clear the entire cache",
				"info",
			);
	}
}
