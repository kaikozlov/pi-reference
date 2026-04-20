import * as fs from "node:fs";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { getRefDir, ensureRefDir, listReferenceTree } from "./helpers";
import { generateIndex, setEntryMetadata } from "./index-gen";
import { addRepo, addFile, removeEntry } from "./entries";
import { listCache, updateCacheEntry, updateAllCache, removeCacheEntry, clearCache, getCacheSize } from "./cache";
import type { RefState } from "./commands";

// ─── Tool definition ─────────────────────────────────────────────────

export function registerRefTool(pi: any, state: RefState) {
	pi.registerTool({
		name: "ref",
		label: "Reference",
		description:
			"Manage the REFERENCE/ directory. " +
			"Actions: 'init' (create dir), 'list' (show tree), 'add' (clone repo or copy file), " +
			"'remove' (delete entry), 'update_index' (regenerate index), " +
			"'describe' (set entry description), 'relevance' (set project relevance), " +
			"'cache_list' (show cached repos), 'cache_update' (pull latest for cached repos), " +
			"'cache_remove' (delete from cache), 'cache_clear' (clear entire cache).",
		promptSnippet: "Manage reference materials (repos, files) in REFERENCE/",
		promptGuidelines: [
			"Use the ref tool when the user wants to add, list, or remove reference materials.",
			"Always update the index after adding or removing entries.",
			"Clone repos into REFERENCE/ when the user wants to reference external code.",
			"Non-git content works too: directories with docs, plans, markdown, any files.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"init",
					"list",
					"add",
					"remove",
					"update_index",
					"describe",
					"relevance",
					"cache_list",
					"cache_update",
					"cache_remove",
					"cache_clear",
				] as const,
			),
			target: Type.Optional(
				Type.String({
					description:
						"Git URL or local file path (for 'add'), entry name (for 'remove', 'describe', 'relevance', 'cache_remove', 'cache_update')",
				}),
			),
			text: Type.Optional(
				Type.String({
					description: "Text content for 'describe' or 'relevance' actions",
				}),
			),
			depth: Type.Optional(
				Type.Number({
					description: "Max depth for 'list' tree (default: 3 for index, unlimited for list command)",
				}),
			),
		}),

		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			switch (params.action) {
				case "init": {
					await ensureRefDir(ctx.cwd);
					state.indexContent = await generateIndex(ctx.cwd);
					state.refInitialized = true;
					return {
						content: [{ type: "text", text: "REFERENCE/ directory initialized and index generated." }],
						details: { action: "init" },
					};
				}

				case "list": {
					const refDir = getRefDir(ctx.cwd);
					if (!fs.existsSync(refDir)) {
						return {
							content: [
								{ type: "text", text: "REFERENCE/ directory does not exist. Use action 'init' to create it." },
							],
							details: { action: "list", entries: [] },
						};
					}
					const tree = listReferenceTree(ctx.cwd, params.depth ?? Infinity);
					return {
						content: [{ type: "text", text: tree }],
						details: { action: "list" },
					};
				}

				case "add": {
					if (!params.target) {
						throw new Error("'target' is required for 'add' action (git URL or local path)");
					}
					await ensureRefDir(ctx.cwd);

					let result: { success: boolean; message: string };
					if (
						params.target.startsWith("http://") ||
						params.target.startsWith("https://") ||
						params.target.startsWith("git@") ||
						params.target.startsWith("ssh://")
					) {
						result = await addRepo(ctx.cwd, params.target);
					} else if (params.target.startsWith("git:")) {
						const url = params.target.startsWith("git://")
							? params.target
							: `https://github.com/${params.target.slice(4)}`;
						result = await addRepo(ctx.cwd, url);
					} else {
						result = await addFile(ctx.cwd, params.target);
					}

					if (result.success) {
						state.indexContent = await generateIndex(ctx.cwd);
					}

					return {
						content: [{ type: "text", text: result.message }],
						details: { action: "add", success: result.success },
					};
				}

				case "remove": {
					if (!params.target) {
						throw new Error("'target' is required for 'remove' action (entry name)");
					}
					const result = await removeEntry(ctx.cwd, params.target);
					if (result.success) {
						state.indexContent = await generateIndex(ctx.cwd);
					}
					return {
						content: [{ type: "text", text: result.message }],
						details: { action: "remove", success: result.success },
					};
				}

				case "update_index": {
					state.indexContent = await generateIndex(ctx.cwd);
					return {
						content: [{ type: "text", text: "Reference index updated successfully." }],
						details: { action: "update_index" },
					};
				}

				case "describe": {
					if (!params.target || !params.text) {
						throw new Error("'target' (entry name) and 'text' (description) are required for 'describe'");
					}
					state.indexContent = await setEntryMetadata(ctx.cwd, params.target, "description", params.text);
					return {
						content: [{ type: "text", text: `Description set for ${params.target}` }],
						details: { action: "describe", entry: params.target },
					};
				}

				case "relevance": {
					if (!params.target || !params.text) {
						throw new Error("'target' (entry name) and 'text' (relevance) are required for 'relevance'");
					}
					state.indexContent = await setEntryMetadata(ctx.cwd, params.target, "relevance", params.text);
					return {
						content: [{ type: "text", text: `Project relevance set for ${params.target}` }],
						details: { action: "relevance", entry: params.target },
					};
				}

				case "cache_list": {
					const entries = listCache();
					const totalSize = getCacheSize();
					if (entries.length === 0) {
						return {
							content: [{ type: "text", text: "Cache is empty." }],
							details: { action: "cache_list", entries: [], totalSize },
						};
					}
					const summary = entries
						.map((e) => `${e.name} (${e.size}${e.isGit ? `, ${e.remote}` : ""})`)
						.join("\n");
					return {
						content: [{ type: "text", text: `Cache (${totalSize}):\n${summary}` }],
						details: { action: "cache_list", entries, totalSize },
					};
				}

				case "cache_update": {
					let results: string[];
					if (params.target) {
						const r = await updateCacheEntry(params.target);
						results = [r.message];
					} else {
						results = await updateAllCache();
					}
					if (state.refInitialized) {
						state.indexContent = await generateIndex(ctx.cwd);
					}
					return {
						content: [{ type: "text", text: results.join("\n") }],
						details: { action: "cache_update" },
					};
				}

				case "cache_remove": {
					if (!params.target) {
						throw new Error("'target' (cache entry name) is required for 'cache_remove'");
					}
					const r = await removeCacheEntry(params.target);
					return {
						content: [{ type: "text", text: r.message }],
						details: { action: "cache_remove", success: r.success },
					};
				}

				case "cache_clear": {
					const result = await clearCache();
					return {
						content: [
							{ type: "text", text: `Cleared cache: removed ${result.removed} entries, freed ${result.freed}` },
						],
						details: { action: "cache_clear", ...result },
					};
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});
}
