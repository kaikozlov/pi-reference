/**
 * Pi Reference Extension
 *
 * Manages a REFERENCE/ directory in the project root for collecting context
 * relevant to the current work: reference repos, files, markdown research, etc.
 *
 * Features:
 * - Auto-injects REFERENCE_INDEX.md contents into the system prompt
 * - Commands: /reference init, list, add, remove, index, describe, cache
 * - LLM tool: `ref` for programmatic access
 * - Shared clone cache at ~/.pi/reference/cache/ to avoid re-cloning
 *
 * Usage:
 * 1. Place in ~/.pi/agent/extensions/pi-reference/ or .pi/extensions/pi-reference/
 * 2. Use /reference init to set up
 * 3. Use /reference add <url> to clone repos or copy files
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getRefDir, getIndexFile } from "./src/helpers";
import { generateIndex } from "./src/index-gen";
import {
	handleInit,
	handleList,
	handleAdd,
	handleRemove,
	handleIndex,
	handleDescribe,
	handleRelevance,
	handleCache,
	type RefState,
} from "./src/commands";
import { registerRefTool } from "./src/tool";

// ─── Subcommand list ─────────────────────────────────────────────────

const SUBCOMMANDS = [
	"init",
	"list",
	"add",
	"remove",
	"index",
	"describe",
	"relevance",
	"cache",
];

// ─── Extension ───────────────────────────────────────────────────────

export default function referenceExtension(pi: ExtensionAPI) {
	const state: RefState = {
		refInitialized: false,
		indexContent: null,
	};

	// ─── Session lifecycle ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const refDir = getRefDir(ctx.cwd);
		state.refInitialized = fs.existsSync(refDir);

		if (state.refInitialized) {
			const indexFile = getIndexFile(ctx.cwd);
			if (fs.existsSync(indexFile)) {
				state.indexContent = await fsp.readFile(indexFile, "utf-8");
			} else {
				state.indexContent = await generateIndex(ctx.cwd);
			}
		}
	});

	// ─── System prompt injection ────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		const additions: string[] = [];

		additions.push(`
## REFERENCE Directory

This project uses a \`REFERENCE/\` directory in the repo root to collect reference materials:
- Reference git repositories (cloned for comparison, not for editing)
- Reference files for testing/comparison
- Research and planning markdown files
- Any miscellaneous files useful for context but not tracked in git

**Important:** Never do coding work inside \`REFERENCE/\`. The most that should happen there is adding debug logging to compare against a reference implementation.
`);

		if (state.refInitialized && state.indexContent) {
			additions.push("### Reference Index\n");
			additions.push(state.indexContent);
			additions.push(
				"\nUse the `ref` tool or `/reference` commands to manage these materials. " +
				"Use `ref` action `list` with `depth` to explore subdirectories in detail.",
			);
		}

		if (additions.length > 0) {
			return {
				systemPrompt: event.systemPrompt + "\n" + additions.join("\n"),
			};
		}
	});

	// ─── Command routing ────────────────────────────────────────────

	pi.registerCommand("reference", {
		description: "Manage the REFERENCE/ directory",
		getArgumentCompletions: (prefix: string) => {
			const filtered = SUBCOMMANDS.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "";
			const rest = parts.slice(1).join(" ");

			switch (sub) {
				case "init":
					await handleInit(ctx, state);
					break;
				case "list":
					await handleList(ctx, rest);
					break;
				case "add":
					await handleAdd(ctx, rest, state);
					break;
				case "remove":
					await handleRemove(ctx, parts[1] || "", state);
					break;
				case "index":
					await handleIndex(ctx, rest, state);
					break;
				case "describe":
					await handleDescribe(ctx, parts[1] || "", parts.slice(2).join(" "), state);
					break;
				case "relevance":
					await handleRelevance(ctx, parts[1] || "", parts.slice(2).join(" "), state);
					break;
				case "cache":
					await handleCache(ctx, parts[1] || "", parts.slice(2).join(" "), state);
					break;
				default:
					ctx.ui.notify(
						"Usage: /reference <command> [args]\n" +
						"\n" +
						"  init                    Create REFERENCE/ dir and git exclude\n" +
						"  list [depth]            Show contents of REFERENCE/ (default: full tree)\n" +
						"  add <url|path> [--as name]   Clone repo or copy file/dir into REFERENCE/\n" +
						"  remove <name>           Remove an entry from REFERENCE/\n" +
						"  index [name]            Regenerate index (or refresh a single entry)\n" +
						"  describe <name> <text>  Set description for an entry\n" +
						"  relevance <name> <text> Set project relevance for an entry\n" +
						"\n" +
						"  cache list              Show cached repos (~/.pi/reference/cache/)\n" +
						"  cache update [name]     Pull latest for cached repos (or one repo)\n" +
						"  cache remove <name>     Remove a repo from the cache\n" +
						"  cache clear             Clear the entire cache",
						"info",
					);
			}
		},
	});

	// ─── LLM Tool ───────────────────────────────────────────────────

	registerRefTool(pi, state);
}
