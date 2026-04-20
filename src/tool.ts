import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { getRefDir, ensureRefDir, isGitRepo, runGit, formatSize } from "./helpers";
import { generateIndex } from "./index-gen";
import { addRepo, addFile, addNpmPackage, removeEntry } from "./entries";
import { listCache, updateCacheEntry, updateAllCache, removeCacheEntry, clearCache, getCacheSize } from "./cache";
import { readSidecar, updateSidecarField } from "./sidecar";
import { setCacheDescription } from "./cache-meta";
import { repairSidecars } from "./commands";
import type { RefState } from "./commands";

// ─── Helper: build info response for an entry ────────────────────────

function buildInfoText(
	entryName: string,
	cwd: string,
	sidecar: Awaited<ReturnType<typeof readSidecar>>,
): string {
	const refDir = getRefDir(cwd);
	const entryPath = path.join(refDir, entryName);
	const parts: string[] = [];

	// Header
	parts.push(`# ${entryName}`);

	// Sidecar frontmatter
	if (sidecar) {
		const fm = sidecar.frontmatter;
		parts.push(`Type: ${fm.type}`);
		if (fm.remote) parts.push(`Remote: ${fm.remote}`);
		if (fm.branch) parts.push(`Branch: ${fm.branch}`);
		if (fm.searchPaths && fm.searchPaths.length > 0) parts.push(`Search paths: ${fm.searchPaths.join(", ")}`);
		if (fm.description) parts.push(`Description: ${fm.description}`);
		if (fm.relevance) parts.push(`Relevance: ${fm.relevance}`);
		if (fm.notes) parts.push(`Notes: ${fm.notes}`);
		if (fm.ephemeral) parts.push(`(ephemeral — not cached)`);
		if (fm.npmPackage) parts.push(`npm: ${fm.npmPackage}${fm.npmVersion ? `@${fm.npmVersion}` : ""}`);
	} else {
		parts.push("(No sidecar found)");
	}

	// Git-specific metadata
	if (fs.existsSync(entryPath) && isGitRepo(entryPath)) {
		const branch = runGit(["branch", "--show-current"], entryPath);
		const log = runGit(["log", "-1", "--oneline"], entryPath);
		if (branch.code === 0 && branch.stdout) parts.push(`Checked out: ${branch.stdout}`);
		if (log.code === 0 && log.stdout) parts.push(`Last commit: ${log.stdout}`);
	}

	// Shallow top-level contents
	if (fs.existsSync(entryPath)) {
		const stat = fs.lstatSync(entryPath);
		if (stat.isDirectory()) {
			try {
				const contents = fs.readdirSync(entryPath)
					.filter((n) => n !== ".git")
					.sort()
					.slice(0, 20);
				if (contents.length > 0) {
					parts.push("");
					parts.push("Contents:");
					for (const name of contents) {
						const full = path.join(entryPath, name);
						try {
							const isDir = fs.statSync(full).isDirectory();
							parts.push(`  ${name}${isDir ? "/" : ""}`);
						} catch {
							parts.push(`  ${name}`);
						}
					}
					const total = fs.readdirSync(entryPath).filter((n) => n !== ".git").length;
					if (total > 20) parts.push(`  ... and ${total - 20} more`);
				}
			} catch { /* skip */ }
		} else {
			parts.push(`Size: ${formatSize(stat.size)}`);
		}
	}

	// Sidecar body
	if (sidecar && sidecar.body) {
		parts.push("");
		parts.push("---");
		parts.push("");
		parts.push(sidecar.body);
	}

	return parts.join("\n");
}

// ─── Tool definition ─────────────────────────────────────────────────

export function registerRefTool(pi: any, state: RefState) {
	pi.registerTool({
		name: "ref",
		label: "Reference",
		description:
			"Manage the REFERENCE/ directory. " +
			"Actions: 'init' (create dir), 'list' (show entries), 'info' (examine entry in detail), " +
			"'add' (clone repo or copy file), 'remove' (delete entry), " +
			"'update_index' (regenerate index), 'describe' (set entry description, syncs to cache), " +
			"'relevance' (set project relevance, local only), 'notes' (set agent notes), " +
			"'cache_list' (show cached repos), 'cache_update' (pull latest for cached repos), " +
			"'cache_remove' (delete from cache), 'cache_clear' (clear entire cache).",
		promptSnippet: "Manage reference materials (repos, files) in REFERENCE/",
		promptGuidelines: [
			"Use the ref tool when the user wants to add, list, or remove reference materials.",
			"Use `ref info <name>` to examine an entry in detail before working with it.",
			"Always update the index after adding or removing entries.",
			"Clone repos into REFERENCE/ when the user wants to reference external code.",
			"Non-git content works too: directories with docs, plans, markdown, any files.",
			"Sidecars at REFERENCE/sidecar/<name>.md — update descriptions and notes with `edit`.",
			"Use paths param to clone only specific subdirectories (sparse checkout) for large repos.",
			"Use branch param to specify a branch; otherwise main/master/trunk/dev are tried automatically.",
			"Use ephemeral=true for one-off references that won't be cached.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"init",
					"list",
					"info",
					"add",
					"remove",
					"update_index",
					"describe",
					"relevance",
					"notes",
					"cache_list",
					"cache_update",
					"cache_remove",
					"cache_clear",
				] as const,
			),
			target: Type.Optional(
				Type.String({
					description:
						"Git URL or local file path (for 'add'), entry name (for 'info', 'remove', 'describe', 'relevance', 'notes', 'cache_remove', 'cache_update')",
				}),
			),
			text: Type.Optional(
				Type.String({
					description: "Text content for 'describe', 'relevance', or 'notes' actions",
				}),
			),
			branch: Type.Optional(
				Type.String({
					description: "Branch to clone (for 'add'). If not set, tries main/master/trunk/dev automatically.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Sparse checkout paths — subdirectories to include (for 'add'). Saves disk for large repos.",
				}),
			),
			ephemeral: Type.Optional(
				Type.Boolean({
					description: "If true, clone without caching (for 'add'). Good for one-off references.",
				}),
			),
		}),

		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			switch (params.action) {
				case "init": {
					await ensureRefDir(ctx.cwd);
					const { created, repaired, seeded } = await repairSidecars(ctx.cwd);
					state.indexContent = await generateIndex(ctx.cwd);
					state.refInitialized = true;

					const parts = ["REFERENCE/ directory initialized."];
					if (created > 0) parts.push(`Created ${created} new sidecar(s).`);
					if (repaired > 0) parts.push(`Repaired ${repaired} sidecar(s) (type/remote).`);
					if (seeded > 0) parts.push(`Seeded descriptions for ${seeded} entry/entries.`);

					return {
						content: [{ type: "text", text: parts.join(" ") }],
						details: { action: "init", created, repaired, seeded },
					};
				}

				case "list": {
					state.indexContent = await generateIndex(ctx.cwd);
					return {
						content: [{ type: "text", text: state.indexContent }],
						details: { action: "list" },
					};
				}

				case "info": {
					if (!params.target) {
						throw new Error("'target' (entry name) is required for 'info' action");
					}
					const refDir = getRefDir(ctx.cwd);
					const entryPath = path.join(refDir, params.target);
					if (!fs.existsSync(entryPath)) {
						return {
							content: [{ type: "text", text: `Entry '${params.target}' not found in REFERENCE/.` }],
							details: { action: "info", found: false },
						};
					}

					const sidecar = await readSidecar(ctx.cwd, params.target);
					const info = buildInfoText(params.target, ctx.cwd, sidecar);

					return {
						content: [{ type: "text", text: info }],
						details: { action: "info", entry: params.target },
					};
				}

				case "add": {
					if (!params.target) {
						throw new Error("'target' is required for 'add' action (git URL or local path)");
					}
					await ensureRefDir(ctx.cwd);

					const repoOpts = {
						branch: params.branch as string | undefined,
						paths: params.paths as string[] | undefined,
						ephemeral: params.ephemeral as boolean | undefined,
					};

					let result: { success: boolean; message: string };
					if (
						params.target.startsWith("http://") ||
						params.target.startsWith("https://") ||
						params.target.startsWith("git@") ||
						params.target.startsWith("ssh://")
					) {
						result = await addRepo(ctx.cwd, params.target, repoOpts);
					} else if (params.target.startsWith("git:")) {
						const url = params.target.startsWith("git://")
							? params.target
							: `https://github.com/${params.target.slice(4)}`;
						result = await addRepo(ctx.cwd, url, repoOpts);
					} else if (params.target.startsWith("npm:")) {
						result = await addNpmPackage(ctx.cwd, params.target);
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
					// Write-through: sidecar + cache-meta
					await updateSidecarField(ctx.cwd, params.target, { description: params.text });
					const sidecar = await readSidecar(ctx.cwd, params.target);
					if (sidecar?.frontmatter.type === "git" && sidecar.frontmatter.remote) {
						await setCacheDescription(params.target, params.text);
					}
					state.indexContent = await generateIndex(ctx.cwd);
					return {
						content: [{ type: "text", text: `Description set for ${params.target} (synced to cache)` }],
						details: { action: "describe", entry: params.target },
					};
				}

				case "relevance": {
					if (!params.target || !params.text) {
						throw new Error("'target' (entry name) and 'text' (relevance) are required for 'relevance'");
					}
					// Sidecar only — project-local
					await updateSidecarField(ctx.cwd, params.target, { relevance: params.text });
					state.indexContent = await generateIndex(ctx.cwd);
					return {
						content: [{ type: "text", text: `Project relevance set for ${params.target}` }],
						details: { action: "relevance", entry: params.target },
					};
				}

				case "notes": {
					if (!params.target || !params.text) {
						throw new Error("'target' (entry name) and 'text' (notes) are required for 'notes'");
					}
					// Sidecar only — project-local agent instructions
					await updateSidecarField(ctx.cwd, params.target, { notes: params.text });
					state.indexContent = await generateIndex(ctx.cwd);
					return {
						content: [{ type: "text", text: `Notes set for ${params.target}` }],
						details: { action: "notes", entry: params.target },
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
