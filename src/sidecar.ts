import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { REFERENCE_DIR, SIDECAR_DIR } from "./constants";
import { getRefDir } from "./helpers";

// ─── Types ───────────────────────────────────────────────────────────

export interface SidecarFrontmatter {
	entry: string;
	type: "git" | "directory" | "file" | "npm";
	remote?: string;
	branch?: string;
	searchPaths?: string[];
	npmPackage?: string;
	npmVersion?: string;
	ephemeral?: boolean;
	description?: string;
	relevance?: string;
	notes?: string;
}

// ─── Path helpers ────────────────────────────────────────────────────

export function getSidecarDir(cwd: string): string {
	return path.join(getRefDir(cwd), SIDECAR_DIR);
}

export function getSidecarPath(cwd: string, entryName: string): string {
	return path.join(getSidecarDir(cwd), `${entryName}.md`);
}

// ─── YAML frontmatter ────────────────────────────────────────────────

function escapeYamlValue(value: string): string {
	// If it contains any special chars, wrap in quotes
	if (/[:#\n'"{}[\],&>*?|!%@`]/.test(value) || value !== value.trim()) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

function generateFrontmatter(fm: SidecarFrontmatter): string {
	const lines: string[] = ["---"];
	lines.push(`entry: ${escapeYamlValue(fm.entry)}`);
	lines.push(`type: ${fm.type}`);
	if (fm.remote) lines.push(`remote: ${escapeYamlValue(fm.remote)}`);
	if (fm.branch) lines.push(`branch: ${escapeYamlValue(fm.branch)}`);
	if (fm.searchPaths && fm.searchPaths.length > 0) {
		lines.push(`searchPaths: [${fm.searchPaths.map((p) => `"${p}"`).join(", ")}]`);
	}
	if (fm.npmPackage) lines.push(`npmPackage: ${escapeYamlValue(fm.npmPackage)}`);
	if (fm.npmVersion) lines.push(`npmVersion: ${escapeYamlValue(fm.npmVersion)}`);
	if (fm.ephemeral) lines.push(`ephemeral: true`);
	if (fm.description) lines.push(`description: ${escapeYamlValue(fm.description)}`);
	if (fm.relevance) lines.push(`relevance: ${escapeYamlValue(fm.relevance)}`);
	if (fm.notes) lines.push(`notes: ${escapeYamlValue(fm.notes)}`);
	lines.push("---");
	return lines.join("\n");
}

function parseFrontmatter(content: string): { frontmatter: SidecarFrontmatter; body: string } | null {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return null;

	const raw = match[1];
	const body = match[2];
	const fm: Partial<SidecarFrontmatter> = {};

	for (const line of raw.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value: string = line.slice(colonIdx + 1).trim();

		// Handle boolean values
		if (value === "true") {
			(fm as any)[key] = true;
			continue;
		} else if (value === "false") {
			(fm as any)[key] = false;
			continue;
		}

		// Handle array values like ["a", "b"]
		if (value.startsWith("[") && value.endsWith("]")) {
			try {
				(fm as any)[key] = JSON.parse(value);
				continue;
			} catch {
				// fall through to string parsing
			}
		}

		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		const validKeys = [
			"entry", "type", "remote", "branch", "searchPaths", "description",
			"relevance", "notes", "npmPackage", "npmVersion", "ephemeral",
		];
		if (validKeys.includes(key)) {
			(fm as any)[key] = value || undefined;
		}
	}

	if (!fm.entry || !fm.type) return null;

	return {
		frontmatter: fm as SidecarFrontmatter,
		body,
	};
}

// ─── CRUD ────────────────────────────────────────────────────────────

/**
 * Create a sidecar file for an entry. Overwrites if it exists.
 */
export async function createSidecar(
	cwd: string,
	entryName: string,
	fm: SidecarFrontmatter,
	body: string = "",
): Promise<string> {
	const sidecarDir = getSidecarDir(cwd);
	await fsp.mkdir(sidecarDir, { recursive: true });

	const content = `${generateFrontmatter(fm)}\n${body}\n`;
	const sidecarPath = getSidecarPath(cwd, entryName);
	await fsp.writeFile(sidecarPath, content, "utf-8");
	return sidecarPath;
}

/**
 * Read a sidecar, returning parsed frontmatter and body.
 * Returns null if the sidecar doesn't exist.
 */
export async function readSidecar(
	cwd: string,
	entryName: string,
): Promise<{ frontmatter: SidecarFrontmatter; body: string; path: string } | null> {
	const sidecarPath = getSidecarPath(cwd, entryName);
	if (!fs.existsSync(sidecarPath)) return null;

	const content = await fsp.readFile(sidecarPath, "utf-8");
	const parsed = parseFrontmatter(content);
	if (!parsed) return null;

	return {
		frontmatter: parsed.frontmatter,
		body: parsed.body.trim(),
		path: sidecarPath,
	};
}

/**
 * Update specific frontmatter fields in an existing sidecar, preserving the body.
 * Creates the sidecar if it doesn't exist (using type/remote from filesystem if available).
 */
export async function updateSidecarField(
	cwd: string,
	entryName: string,
	updates: Partial<Pick<SidecarFrontmatter, "description" | "relevance" | "notes" | "branch" | "searchPaths" | "ephemeral" | "npmPackage" | "npmVersion">>,
): Promise<void> {
	const existing = await readSidecar(cwd, entryName);

	if (existing) {
		const fm = { ...existing.frontmatter, ...updates };
		const content = `${generateFrontmatter(fm)}\n${existing.body}\n`;
		await fsp.writeFile(existing.path, content, "utf-8");
	}
}

/**
 * Delete a sidecar file. No-op if it doesn't exist.
 */
export async function deleteSidecar(cwd: string, entryName: string): Promise<void> {
	const sidecarPath = getSidecarPath(cwd, entryName);
	if (fs.existsSync(sidecarPath)) {
		await fsp.unlink(sidecarPath);
	}
}

/**
 * List all sidecar files in REFERENCE/sidecar/.
 */
export function listSidecars(cwd: string): string[] {
	const sidecarDir = getSidecarDir(cwd);
	if (!fs.existsSync(sidecarDir)) return [];
	return fs
		.readdirSync(sidecarDir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3));
}

/**
 * Read all sidecars, returning frontmatter for each entry.
 * Used to generate the index manifest.
 */
export async function readAllSidecars(cwd: string): Promise<Map<string, SidecarFrontmatter>> {
	const result = new Map<string, SidecarFrontmatter>();
	const names = listSidecars(cwd);

	for (const name of names) {
		const sidecar = await readSidecar(cwd, name);
		if (sidecar) {
			result.set(name, sidecar.frontmatter);
		}
	}

	return result;
}
