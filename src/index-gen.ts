import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { INDEX_FILE, DEFAULT_TREE_DEPTH, MAX_ITEMS_PER_DIR } from "./constants";
import {
	getRefDir,
	getIndexFile,
	isGitRepo,
	runGit,
	listReferenceTree,
	countFilesRecursive,
	collectExtensions,
	formatSize,
} from "./helpers";

// ─── Types ───────────────────────────────────────────────────────────

export interface EntryMetadata {
	description: string | null;
	relevance: string | null;
}

// ─── Metadata persistence ────────────────────────────────────────────

/**
 * Read persisted metadata (description + relevance) for all entries from the existing index file.
 */
export async function readPersistedMetadata(cwd: string): Promise<Map<string, EntryMetadata>> {
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
export async function setEntryMetadata(
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

// ─── Index generation ────────────────────────────────────────────────

/**
 * Generate or update REFERENCE_INDEX.md.
 */
export async function generateIndex(cwd: string, persistedMeta?: Map<string, EntryMetadata>): Promise<string> {
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
		lines.push(listReferenceTree(cwd, DEFAULT_TREE_DEPTH, MAX_ITEMS_PER_DIR));
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
