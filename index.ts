/**
 * Pi Reference Extension
 *
 * Manages a REFERENCE/ directory in the project root for collecting context
 * relevant to the current work: reference repos, files, markdown research, etc.
 *
 * Features:
 * - Slim system prompt injection with flat entry manifest from sidecars
 * - Commands: /reference init, list, add, remove, index, describe, relevance, cache
 * - LLM tool: `ref` for programmatic access, including `info` for deep inspection
 * - Sidecar files (REFERENCE/sidecar/<name>.md) with YAML frontmatter for metadata
 * - Shared clone cache at ~/.pi/reference/cache/ with write-through description sync
 * - Proactive description seeding via GitHub API on add
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRefDir, getIndexFile } from "./src/helpers";
import { generateIndex, generateManifest } from "./src/index-gen";
import {
	handleHelp,
	handleInit,
	handleList,
	handleAdd,
	handleRemove,
	handleIndex,
	handleDescribe,
	handleRelevance,
	handleNotes,
	handleCache,
	setAutocompleteCwd,
	getArgumentCompletions,
	parseArgs,
	type RefState,
} from "./src/commands";
import { registerRefTool } from "./src/tool";

// ─── Extension ───────────────────────────────────────────────────────

export default function referenceExtension(pi: ExtensionAPI) {
	const state: RefState = {
		refInitialized: false,
		indexContent: null,
	};

	// ─── Session lifecycle ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		setAutocompleteCwd(ctx.cwd);
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

		if (state.refInitialized) {
			const manifest = await generateManifest(event.cwd ?? "");
			if (manifest) {
				additions.push("### Reference entries");
				additions.push("```");
				additions.push(manifest);
				additions.push("```");
				additions.push(
					"Use `ref info <name>` to examine an entry in detail.",
				);
				additions.push(
					"Sidecars at `REFERENCE/sidecar/<name>.md` — update descriptions and notes with `edit`.",
				);
			}
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
		getArgumentCompletions,
		handler: async (args, ctx) => {
			const { cmd: sub, rest } = parseArgs(args);

			switch (sub) {
				case "init":
					await handleInit(ctx, state);
					break;
				case "list":
					await handleList(ctx, state);
					break;
				case "add":
					await handleAdd(ctx, rest, state);
					break;
				case "remove":
					await handleRemove(ctx, rest, state);
					break;
				case "index":
					await handleIndex(ctx, state);
					break;
				case "describe": {
					const dParts = rest.split(/\s+/);
					await handleDescribe(ctx, dParts[0] || "", dParts.slice(1).join(" "), state);
					break;
				}
				case "relevance": {
					const rParts = rest.split(/\s+/);
					await handleRelevance(ctx, rParts[0] || "", rParts.slice(1).join(" "), state);
					break;
				}
				case "notes": {
					const nParts = rest.split(/\s+/);
					await handleNotes(ctx, nParts[0] || "", nParts.slice(1).join(" "), state);
					break;
				}
				case "cache": {
					const cParts = rest.split(/\s+/);
					await handleCache(ctx, cParts[0] || "", cParts.slice(1).join(" "), state);
					break;
				}
				default:
					await handleHelp(ctx);
			}
		},
	});

	// ─── LLM Tool ───────────────────────────────────────────────────

	registerRefTool(pi, state);
}
