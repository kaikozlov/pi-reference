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
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Constants ───────────────────────────────────────────────────────
const REFERENCE_DIR = "REFERENCE";
const INDEX_FILE = "REFERENCE_INDEX.md";
const CACHE_DIR = path.join(os.homedir(), ".pi", "reference", "cache");
const DEFAULT_TREE_DEPTH = 3;

// ─── Helpers ─────────────────────────────────────────────────────────

function getRefDir(cwd: string): string {
	return path.join(cwd, REFERENCE_DIR);
}

function getIndexFile(cwd: string): string {
	return path.join(getRefDir(cwd), INDEX_FILE);
}

function isGitRepo(dirPath: string): boolean {
	return fs.existsSync(path.join(dirPath, ".git"));
}

function runGit(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
	try {
		const result = cp.spawnSync("git", args, {
			cwd,
			encoding: "utf-8",
			timeout: 60_000,
		});
		return {
			stdout: result.stdout?.trim() ?? "",
			stderr: result.stderr?.trim() ?? "",
			code: result.status ?? 1,
		};
	} catch {
		return { stdout: "", stderr: "git command failed", code: 1 };
	}
}

/**
 * Ensure the REFERENCE/ dir exists and is git-excluded.
 * Returns true if created newly, false if already existed.
 */
async function ensureRefDir(cwd: string): Promise<boolean> {
	const refDir = getRefDir(cwd);
	let created = false;

	if (!fs.existsSync(refDir)) {
		await fsp.mkdir(refDir, { recursive: true });
		created = true;
	}

	// Add REFERENCE/ to .git/info/exclude if not already there
	const excludeFile = path.join(cwd, ".git", "info", "exclude");
	if (fs.existsSync(excludeFile)) {
		const content = await fsp.readFile(excludeFile, "utf-8");
		if (!content.split("\n").some((line) => line.trim() === "REFERENCE/")) {
			await fsp.appendFile(excludeFile, "\nREFERENCE/\n");
		}
	}

	return created;
}

/**
 * Generate a tree-like listing of the REFERENCE/ directory.
 * maxDepth controls how deep to recurse (Infinity = full tree).
 */
function listReferenceTree(cwd: string, maxDepth: number = Infinity): string {
	const refDir = getRefDir(cwd);
	if (!fs.existsSync(refDir)) {
		return "(REFERENCE/ directory does not exist. Run /reference init)";
	}

	const lines: string[] = [];

	function walk(dir: string, prefix: string, depth: number) {
		if (depth > maxDepth) return;

		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const sorted = entries
			.filter((e) => e.name !== ".git")
			.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1;
				if (!a.isDirectory() && b.isDirectory()) return 1;
				return a.name.localeCompare(b.name);
			});

		for (let i = 0; i < sorted.length; i++) {
			const entry = sorted[i];
			const isLast = i === sorted.length - 1;
			const connector = isLast ? "└── " : "├── ";
			const childPrefix = isLast ? "    " : "│   ";

			if (entry.isDirectory()) {
				if (depth === maxDepth) {
					const childCount = fs.readdirSync(path.join(dir, entry.name)).filter((n) => n !== ".git").length;
					lines.push(`${prefix}${connector}${entry.name}/ (${childCount} items)`);
				} else {
					const isRepo = fs.existsSync(path.join(dir, entry.name, ".git"));
					const suffix = isRepo ? " (git repo)" : "";
					lines.push(`${prefix}${connector}${entry.name}/${suffix}`);
					walk(path.join(dir, entry.name), prefix + childPrefix, depth + 1);
				}
			} else {
				const size = fs.statSync(path.join(dir, entry.name)).size;
				const sizeStr =
					size > 1024 * 1024
						? ` (${(size / 1024 / 1024).toFixed(1)}MB)`
						: size > 1024
							? ` (${(size / 1024).toFixed(0)}KB)`
							: "";
				lines.push(`${prefix}${connector}${entry.name}${sizeStr}`);
			}
		}
	}

	lines.push("REFERENCE/");
	walk(refDir, "", 0);
	return lines.join("\n");
}

// ─── Index metadata persistence ──────────────────────────────────────

interface EntryMetadata {
	description: string | null;
	relevance: string | null;
}

/**
 * Read persisted metadata (description + relevance) for all entries from the existing index file.
 */
async function readPersistedMetadata(cwd: string): Promise<Map<string, EntryMetadata>> {
	const meta = new Map<string, EntryMetadata>();
	const indexFile = getIndexFile(cwd);
	if (!fs.existsSync(indexFile)) return meta;

	const content = await fsp.readFile(indexFile, "utf-8");

	// Split into sections by ### headers
	const sections = content.split(/^### /m);
	for (const section of sections.slice(1)) {
		const firstLine = section.split("\n")[0] ?? "";
		const name = firstLine.trim();
		if (!name) continue;

		const descMatch = section.match(/- \*\*Description:\*\* (.+)/);
		const relMatch = section.match(/- \*\*Project relevance:\*\* (.+)/);

		const desc = descMatch ? descMatch[1].trim() : null;
		const rel = relMatch ? relMatch[1].trim() : null;

		if ((desc && !desc.startsWith("_(")) || (rel && !rel.startsWith("_("))) {
			meta.set(name, {
				description: desc?.startsWith("_(") ? null : desc,
				relevance: rel?.startsWith("_(") ? null : rel,
			});
		}
	}

	return meta;
}

/**
 * Set metadata for a specific entry, then regenerate the index.
 */
async function setEntryMetadata(
	cwd: string,
	entryName: string,
	field: "description" | "relevance",
	value: string,
): Promise<string> {
	const meta = await readPersistedMetadata(cwd);
	const existing = meta.get(entryName) ?? { description: null, relevance: null };
	existing[field] = value;
	meta.set(entryName, existing);
	return generateIndex(cwd, meta);
}

/**
 * Generate or update REFERENCE_INDEX.md.
 */
async function generateIndex(cwd: string, persistedMeta?: Map<string, EntryMetadata>): Promise<string> {
	const refDir = getRefDir(cwd);
	if (!fs.existsSync(refDir)) {
		return "# Reference Index\n\n(No REFERENCE/ directory yet. Run /reference init)\n";
	}

	const meta = persistedMeta ?? (await readPersistedMetadata(cwd));

	const lines: string[] = [];
	lines.push("# Reference Index");
	lines.push("");
	lines.push("This directory contains reference materials for the project.");
	lines.push("Do not do coding work inside REFERENCE/ — it exists only for context.");
	lines.push("");

	const entries = fs
		.readdirSync(refDir, { withFileTypes: true })
		.filter((e) => e.name !== INDEX_FILE && e.name !== ".git");

	if (entries.length === 0) {
		lines.push("(Empty — use /reference add to add repos or files)");
	} else {
		lines.push("## Contents");
		lines.push("");
		lines.push("```");
		lines.push(listReferenceTree(cwd, DEFAULT_TREE_DEPTH));
		lines.push("```");
		lines.push("");

		for (const entry of entries) {
			const entryPath = path.join(refDir, entry.name);
			const entryMeta = meta.get(entry.name);
			lines.push(`### ${entry.name}`);

			if (entry.isDirectory() && isGitRepo(entryPath)) {
				const remote = runGit(["remote", "get-url", "origin"], entryPath);
				const log = runGit(["log", "-1", "--oneline"], entryPath);
				const branch = runGit(["branch", "--show-current"], entryPath);
				const url = remote.code === 0 ? remote.stdout : "(unknown remote)";
				const lastCommit = log.code === 0 ? log.stdout : "(unknown)";
				const branchName = branch.code === 0 ? branch.stdout : "";
				lines.push(`- **Type:** Git repository`);
				lines.push(`- **Remote:** ${url}`);
				if (branchName) lines.push(`- **Branch:** ${branchName}`);
				lines.push(`- **Last commit:** ${lastCommit}`);
			} else if (entry.isDirectory()) {
				const fileCount = countFilesRecursive(entryPath);
				const extensions = collectExtensions(entryPath);
				const typeSummary = extensions.length > 0 ? extensions.join(", ") : "mixed";
				lines.push(`- **Type:** Directory (${fileCount} files: ${typeSummary})`);
			} else {
				const stat = fs.statSync(entryPath);
				const ext = path.extname(entry.name);
				lines.push(`- **Type:** File (${formatSize(stat.size)}${ext ? `, ${ext}` : ""})`);
			}

			if (entryMeta?.description) {
				lines.push(`- **Description:** ${entryMeta.description}`);
			} else {
				lines.push(`- **Description:** _(not yet described)_`);
			}

			if (entryMeta?.relevance) {
				lines.push(`- **Project relevance:** ${entryMeta.relevance}`);
			} else {
				lines.push(`- **Project relevance:** _(not yet assessed)_`);
			}

			lines.push("");
		}
	}

	const content = lines.join("\n");
	await fsp.mkdir(refDir, { recursive: true });
	await fsp.writeFile(getIndexFile(cwd), content, "utf-8");
	return content;
}

function countFilesRecursive(dir: string): number {
	let count = 0;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".git") continue;
		if (entry.isDirectory()) {
			count += countFilesRecursive(path.join(dir, entry.name));
		} else {
			count++;
		}
	}
	return count;
}

function collectExtensions(dir: string): string[] {
	const extCounts = new Map<string, number>();

	function walk(d: string) {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			if (entry.isDirectory()) {
				walk(path.join(d, entry.name));
			} else {
				const ext = path.extname(entry.name) || "(no ext)";
				extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
			}
		}
	}

	walk(dir);
	return Array.from(extCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([ext, count]) => `${ext}(${count})`);
}

function formatSize(bytes: number): string {
	if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
	if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${bytes}B`;
}

function formatDirSize(dirPath: string): string {
	let total = 0;
	try {
		function walk(d: string) {
			for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
				if (entry.name === ".git") continue;
				const full = path.join(d, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else {
					try {
						total += fs.statSync(full).size;
					} catch { /* skip */ }
				}
			}
		}
		walk(dirPath);
	} catch { /* skip */ }
	return formatSize(total);
}

function getDirSize(dirPath: string): number {
	let total = 0;
	try {
		for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
			const full = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				total += getDirSize(full);
			} else {
				try { total += fs.statSync(full).size; } catch { /* skip */ }
			}
		}
	} catch { /* skip */ }
	return total;
}

function getCacheSize(): string {
	if (!fs.existsSync(CACHE_DIR)) return "0B";
	return formatSize(getDirSize(CACHE_DIR));
}

// ─── Cache management ────────────────────────────────────────────────

function listCache(): { name: string; size: string; isGit: boolean; remote: string }[] {
	if (!fs.existsSync(CACHE_DIR)) return [];

	return fs
		.readdirSync(CACHE_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => {
			const cachePath = path.join(CACHE_DIR, e.name);
			const isGit = fs.existsSync(path.join(cachePath, ".git"));
			let remote = "";
			if (isGit) {
				const result = runGit(["remote", "get-url", "origin"], cachePath);
				remote = result.code === 0 ? result.stdout : "";
			}
			return { name: e.name, size: formatDirSize(cachePath), isGit, remote };
		});
}

async function updateCacheEntry(name: string): Promise<{ success: boolean; message: string }> {
	const cachePath = path.join(CACHE_DIR, name);
	if (!fs.existsSync(cachePath)) {
		return { success: false, message: `${name} not found in cache` };
	}
	if (!isGitRepo(cachePath)) {
		return { success: false, message: `${name} is not a git repo, nothing to update` };
	}
	const pull = runGit(["pull", "--ff-only"], cachePath);
	if (pull.code !== 0) {
		return { success: false, message: `Update failed: ${pull.stderr || pull.stdout}` };
	}
	return { success: true, message: `Updated ${name}: ${pull.stdout || "already up to date"}` };
}

async function updateAllCache(): Promise<string[]> {
	const entries = listCache().filter((e) => e.isGit);
	const results: string[] = [];
	for (const entry of entries) {
		const r = await updateCacheEntry(entry.name);
		results.push(r.message);
	}
	return results;
}

async function removeCacheEntry(name: string): Promise<{ success: boolean; message: string }> {
	const cachePath = path.join(CACHE_DIR, name);
	if (!fs.existsSync(cachePath)) {
		return { success: false, message: `${name} not found in cache` };
	}
	await fsp.rm(cachePath, { recursive: true });
	return { success: true, message: `Removed ${name} from cache` };
}

async function clearCache(): Promise<{ removed: number; freed: string }> {
	if (!fs.existsSync(CACHE_DIR)) return { removed: 0, freed: "0B" };
	const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
	let totalSize = 0;
	for (const entry of entries) {
		const p = path.join(CACHE_DIR, entry.name);
		totalSize += getDirSize(p);
		await fsp.rm(p, { recursive: true });
	}
	return { removed: entries.length, freed: formatSize(totalSize) };
}

// ─── Add / Remove ────────────────────────────────────────────────────

async function addRepo(cwd: string, url: string, name?: string): Promise<{ success: boolean; message: string }> {
	await ensureRefDir(cwd);

	const repoName = name || extractRepoName(url);
	const cachePath = path.join(CACHE_DIR, repoName);
	const targetPath = path.join(getRefDir(cwd), repoName);

	if (fs.existsSync(targetPath)) {
		return { success: false, message: `${repoName} already exists in REFERENCE/` };
	}

	if (!fs.existsSync(cachePath)) {
		await fsp.mkdir(CACHE_DIR, { recursive: true });
		const result = runGit(["clone", url, cachePath]);
		if (result.code !== 0) {
			return { success: false, message: `Clone failed: ${result.stderr}` };
		}
	} else {
		runGit(["fetch", "--all"], cachePath);
		runGit(["pull"], cachePath);
	}

	try {
		await fsp.symlink(cachePath, targetPath);
		return { success: true, message: `Added ${repoName} (linked from cache)` };
	} catch {
		await fsp.cp(cachePath, targetPath, { recursive: true });
		return { success: true, message: `Added ${repoName} (copied from cache)` };
	}
}

async function addFile(cwd: string, filePath: string, name?: string): Promise<{ success: boolean; message: string }> {
	await ensureRefDir(cwd);

	const absPath = path.resolve(cwd, filePath);
	if (!fs.existsSync(absPath)) {
		return { success: false, message: `File not found: ${filePath}` };
	}

	const targetName = name || path.basename(absPath);
	const targetPath = path.join(getRefDir(cwd), targetName);

	if (fs.existsSync(targetPath)) {
		return { success: false, message: `${targetName} already exists in REFERENCE/` };
	}

	const stat = fs.statSync(absPath);
	if (stat.isDirectory()) {
		await fsp.cp(absPath, targetPath, { recursive: true });
	} else {
		await fsp.copyFile(absPath, targetPath);
	}

	return { success: true, message: `Added ${targetName} to REFERENCE/` };
}

async function removeEntry(cwd: string, name: string): Promise<{ success: boolean; message: string }> {
	const targetPath = path.join(getRefDir(cwd), name);
	if (!fs.existsSync(targetPath)) {
		return { success: false, message: `${name} not found in REFERENCE/` };
	}

	const stat = fs.lstatSync(targetPath);
	if (stat.isSymbolicLink()) {
		await fsp.unlink(targetPath);
	} else if (stat.isDirectory()) {
		await fsp.rm(targetPath, { recursive: true });
	} else {
		await fsp.unlink(targetPath);
	}

	return { success: true, message: `Removed ${name} from REFERENCE/` };
}

function extractRepoName(url: string): string {
	const match = url.match(/([^\/]+?)(?:\.git)?$/);
	return match ? match[1] : "unknown-repo";
}

function listEntries(cwd: string): string[] {
	const refDir = getRefDir(cwd);
	if (!fs.existsSync(refDir)) return [];
	return fs
		.readdirSync(refDir, { withFileTypes: true })
		.filter((e) => e.name !== INDEX_FILE && e.name !== ".git")
		.map((e) => e.name);
}

// ─── Extension ───────────────────────────────────────────────────────

export default function referenceExtension(pi: ExtensionAPI) {
	let refInitialized = false;
	let indexContent: string | null = null;

	// ─── Session lifecycle ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const refDir = getRefDir(ctx.cwd);
		refInitialized = fs.existsSync(refDir);

		if (refInitialized) {
			const indexFile = getIndexFile(ctx.cwd);
			if (fs.existsSync(indexFile)) {
				indexContent = await fsp.readFile(indexFile, "utf-8");
			} else {
				indexContent = await generateIndex(ctx.cwd);
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

		if (refInitialized && indexContent) {
			additions.push("### Reference Index\n");
			additions.push(indexContent);
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
					await handleInit(ctx);
					break;
				case "list":
					await handleList(ctx, rest);
					break;
				case "add":
					await handleAdd(ctx, rest);
					break;
				case "remove":
					await handleRemove(ctx, rest);
					break;
				case "index":
					await handleIndex(ctx, rest);
					break;
				case "describe":
					await handleDescribe(ctx, parts[1] || "", parts.slice(2).join(" "));
					break;
				case "relevance":
					await handleRelevance(ctx, parts[1] || "", parts.slice(2).join(" "));
					break;
				case "cache":
					await handleCache(ctx, parts[1] || "", parts.slice(2).join(" "));
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

	// ─── Command handlers ───────────────────────────────────────────

	async function handleInit(ctx: ExtensionContext) {
		const created = await ensureRefDir(ctx.cwd);
		indexContent = await generateIndex(ctx.cwd);
		refInitialized = true;

		if (created) {
			ctx.ui.notify("✓ Created REFERENCE/ directory and added to .git/info/exclude", "info");
		} else {
			ctx.ui.notify("✓ REFERENCE/ directory already exists. Index refreshed.", "info");
		}
	}

	async function handleList(ctx: ExtensionContext, depthArg: string) {
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

	async function handleAdd(ctx: ExtensionContext, input: string) {
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
			indexContent = await generateIndex(ctx.cwd);
			ctx.ui.notify(`✓ ${result.message}`, "info");
		} else {
			ctx.ui.notify(`✗ ${result.message}`, "error");
		}
	}

	async function handleRemove(ctx: ExtensionContext, name: string) {
		if (!name) {
			ctx.ui.notify("Usage: /reference remove <name>", "warning");
			return;
		}

		const result = await removeEntry(ctx.cwd, name);
		if (result.success) {
			indexContent = await generateIndex(ctx.cwd);
			ctx.ui.notify(`✓ ${result.message}`, "info");
		} else {
			ctx.ui.notify(`✗ ${result.message}`, "error");
		}
	}

	async function handleIndex(ctx: ExtensionContext, subarg: string) {
		if (!subarg || subarg === "update" || subarg === "regenerate") {
			indexContent = await generateIndex(ctx.cwd);
			ctx.ui.notify("✓ Reference index regenerated", "info");
		} else {
			const entries = listEntries(ctx.cwd);
			if (!entries.includes(subarg)) {
				ctx.ui.notify(`Entry '${subarg}' not found. Available: ${entries.join(", ") || "(empty)"}`, "warning");
				return;
			}
			indexContent = await generateIndex(ctx.cwd);
			ctx.ui.notify(`✓ Reference index refreshed (entry: ${subarg})`, "info");
		}
	}

	async function handleDescribe(ctx: ExtensionContext, name: string, text: string) {
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
		indexContent = await setEntryMetadata(ctx.cwd, name, "description", text);
		ctx.ui.notify(`✓ Description set for ${name}`, "info");
	}

	async function handleRelevance(ctx: ExtensionContext, name: string, text: string) {
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
		indexContent = await setEntryMetadata(ctx.cwd, name, "relevance", text);
		ctx.ui.notify(`✓ Project relevance set for ${name}`, "info");
	}

	async function handleCache(ctx: ExtensionContext, sub: string, rest: string) {
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
				if (refInitialized) {
					indexContent = await generateIndex(ctx.cwd);
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

	// ─── LLM Tool ───────────────────────────────────────────────────

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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "init": {
					await ensureRefDir(ctx.cwd);
					indexContent = await generateIndex(ctx.cwd);
					refInitialized = true;
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
						indexContent = await generateIndex(ctx.cwd);
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
						indexContent = await generateIndex(ctx.cwd);
					}
					return {
						content: [{ type: "text", text: result.message }],
						details: { action: "remove", success: result.success },
					};
				}

				case "update_index": {
					indexContent = await generateIndex(ctx.cwd);
					return {
						content: [{ type: "text", text: "Reference index updated successfully." }],
						details: { action: "update_index" },
					};
				}

				case "describe": {
					if (!params.target || !params.text) {
						throw new Error("'target' (entry name) and 'text' (description) are required for 'describe'");
					}
					indexContent = await setEntryMetadata(ctx.cwd, params.target, "description", params.text);
					return {
						content: [{ type: "text", text: `Description set for ${params.target}` }],
						details: { action: "describe", entry: params.target },
					};
				}

				case "relevance": {
					if (!params.target || !params.text) {
						throw new Error("'target' (entry name) and 'text' (relevance) are required for 'relevance'");
					}
					indexContent = await setEntryMetadata(ctx.cwd, params.target, "relevance", params.text);
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
					if (refInitialized) {
						indexContent = await generateIndex(ctx.cwd);
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
