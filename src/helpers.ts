import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as cp from "node:child_process";
import { REFERENCE_DIR, INDEX_FILE, MAX_ITEMS_PER_DIR } from "./constants";

// ─── Path helpers ────────────────────────────────────────────────────

export function getRefDir(cwd: string): string {
	return path.join(cwd, REFERENCE_DIR);
}

export function getIndexFile(cwd: string): string {
	return path.join(getRefDir(cwd), INDEX_FILE);
}

export function isGitRepo(dirPath: string): boolean {
	return fs.existsSync(path.join(dirPath, ".git"));
}

// ─── Git helpers ─────────────────────────────────────────────────────

export function runGit(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
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

// ─── Directory helpers ───────────────────────────────────────────────

/**
 * Ensure the REFERENCE/ dir exists and is git-excluded.
 * Returns true if created newly, false if already existed.
 */
export async function ensureRefDir(cwd: string): Promise<boolean> {
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
export function listReferenceTree(cwd: string, maxDepth: number = Infinity, maxItems: number = Infinity): string {
	const refDir = getRefDir(cwd);
	if (!fs.existsSync(refDir)) {
		return "(REFERENCE/ directory does not exist. Run /reference init)";
	}

	const lines: string[] = [];

	function walk(dir: string, prefix: string, depth: number) {
		if (depth > maxDepth) return;

		let entries = fs.readdirSync(dir, { withFileTypes: true });
		entries = entries
			.filter((e) => e.name !== ".git")
			.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1;
				if (!a.isDirectory() && b.isDirectory()) return 1;
				return a.name.localeCompare(b.name);
			});

		const truncated = maxItems > 0 && entries.length > maxItems;
		const visible = truncated ? entries.slice(0, maxItems) : entries;
		const remaining = truncated ? entries.length - maxItems : 0;

		for (let i = 0; i < visible.length; i++) {
			const entry = visible[i];
			const isVisualLast = i === visible.length - 1 && !truncated;
			const connector = isVisualLast ? "└── " : "├── ";
			const childPrefix = isVisualLast ? "    " : "│   ";

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

		if (truncated) {
			lines.push(`${prefix}└── ... and ${remaining} more`);
		}
	}

	lines.push("REFERENCE/");
	walk(refDir, "", 0);
	return lines.join("\n");
}

// ─── Size formatting ─────────────────────────────────────────────────

export function formatSize(bytes: number): string {
	if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
	if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${bytes}B`;
}

export function getDirSize(dirPath: string): number {
	let total = 0;
	try {
		for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
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

export function formatDirSize(dirPath: string): string {
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

export function countFilesRecursive(dir: string): number {
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

export function collectExtensions(dir: string): string[] {
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

// ─── Misc helpers ────────────────────────────────────────────────────

export function extractRepoName(url: string): string {
	const match = url.match(/([^\/]+?)(?:\.git)?$/);
	return match ? match[1] : "unknown-repo";
}

export function listEntries(cwd: string): string[] {
	const refDir = getRefDir(cwd);
	if (!fs.existsSync(refDir)) return [];
	return fs
		.readdirSync(refDir, { withFileTypes: true })
		.filter((e) => e.name !== INDEX_FILE && e.name !== ".git")
		.map((e) => e.name);
}
