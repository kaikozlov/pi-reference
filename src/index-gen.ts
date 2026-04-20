import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { INDEX_FILE } from "./constants";
import { getRefDir, getIndexFile, formatSize } from "./helpers";
import { readAllSidecars, type SidecarFrontmatter } from "./sidecar";

// ─── Manifest line generation ────────────────────────────────────────

/**
 * Format a source identifier for an entry based on its frontmatter.
 *   git repos  → gh:owner/repo:branch
 *   files      → file, <size>
 *   dirs       → directory
 */
function formatSource(fm: SidecarFrontmatter, cwd: string): string {
	if (fm.type === "git" && fm.remote) {
		// Extract owner/repo from URL
		const match = fm.remote.match(/github\.com[/:]([^/]+\/[^/\s#?]+?)(?:\.git)?$/);
		if (match) return `gh:${match[1]}`;
		return fm.remote;
	}
	if (fm.type === "file") {
		// Try to get file size
		const entryPath = `${getRefDir(cwd)}/${fm.entry}`;
		try {
			const stat = fs.statSync(entryPath);
			return `file, ${formatSize(stat.size)}`;
		} catch {
			return "file";
		}
	}
	return "directory";
}

/**
 * Build a single manifest line for an entry.
 * Format: name — source — description — relevance
 */
function manifestLine(fm: SidecarFrontmatter, cwd: string): string {
	const source = formatSource(fm, cwd);
	const desc = fm.description ?? "_(no description)_";
	const rel = fm.relevance ?? "_(no relevance set)_";
	return `  ${fm.entry} — ${source} — ${desc} — ${rel}`;
}

// ─── Index generation ────────────────────────────────────────────────

/**
 * Generate or update REFERENCE_INDEX.md as a slim manifest.
 * Reads canonical data from sidecar frontmatter.
 */
export async function generateIndex(cwd: string): Promise<string> {
	const refDir = getRefDir(cwd);
	if (!fs.existsSync(refDir)) {
		return "# Reference Index\n\n(No REFERENCE/ directory yet. Run /reference init)\n";
	}

	const sidecars = await readAllSidecars(cwd);

	// Also pick up entries that don't have sidecars yet (legacy or manual additions)
	const entries = fs
		.readdirSync(refDir, { withFileTypes: true })
		.filter((e) => e.name !== INDEX_FILE && e.name !== ".git" && e.name !== "sidecar");

	const lines: string[] = [];
	lines.push("# Reference Index");
	lines.push("");
	lines.push("This directory contains reference materials for the project.");
	lines.push("Do not do coding work inside REFERENCE/ — it exists only for context.");
	lines.push("");

	if (entries.length === 0) {
		lines.push("(Empty — use /reference add to add repos or files)");
	} else {
		for (const entry of entries) {
			const fm = sidecars.get(entry.name);
			if (fm) {
				lines.push(manifestLine(fm, cwd));
			} else {
				// Entry without a sidecar — barebones line
				const isDir = fs.statSync(path.join(refDir, entry.name)).isDirectory();
				lines.push(`  ${entry.name} — ${isDir ? "directory" : "file"} — _(no description)_ — _(no relevance set)_`);
			}
		}
	}

	const content = lines.join("\n");
	await fsp.mkdir(refDir, { recursive: true });
	await fsp.writeFile(getIndexFile(cwd), content, "utf-8");
	return content;
}

/**
 * Generate the manifest portion for system prompt injection.
 * Returns just the entry lines (no header/footer).
 */
export async function generateManifest(cwd: string): Promise<string> {
	const refDir = getRefDir(cwd);
	if (!fs.existsSync(refDir)) return "";

	const sidecars = await readAllSidecars(cwd);
	const entries = fs
		.readdirSync(refDir, { withFileTypes: true })
		.filter((e) => e.name !== INDEX_FILE && e.name !== ".git" && e.name !== "sidecar");

	if (entries.length === 0) return "";

	const lines: string[] = [];
	for (const entry of entries) {
		const fm = sidecars.get(entry.name);
		if (fm) {
			lines.push(manifestLine(fm, cwd));
		} else {
			const isDir = fs.statSync(path.join(refDir, entry.name)).isDirectory();
			lines.push(`  ${entry.name} — ${isDir ? "directory" : "file"} — _(no description)_ — _(no relevance set)_`);
		}
	}
	return lines.join("\n");
}
