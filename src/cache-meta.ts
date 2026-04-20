import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import { CACHE_META_FILE, CACHE_DIR } from "./constants";
import { extractRepoName } from "./helpers";

// ─── Types ───────────────────────────────────────────────────────────

export interface CacheMetaEntry {
	description: string;
	remote?: string;
	updated: string; // ISO timestamp
}

export type CacheMeta = Record<string, CacheMetaEntry>;

// ─── CRUD ────────────────────────────────────────────────────────────

export async function readCacheMeta(): Promise<CacheMeta> {
	if (!fs.existsSync(CACHE_META_FILE)) return {};
	try {
		const content = await fsp.readFile(CACHE_META_FILE, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

async function writeCacheMeta(meta: CacheMeta): Promise<void> {
	const dir = path.dirname(CACHE_META_FILE);
	await fsp.mkdir(dir, { recursive: true });
	await fsp.writeFile(CACHE_META_FILE, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Get cache meta for a specific repo name.
 */
export async function getCacheMetaEntry(name: string): Promise<CacheMetaEntry | undefined> {
	const meta = await readCacheMeta();
	return meta[name];
}

/**
 * Set the description for a cached repo. Write-through — updates cache-meta.json.
 * Returns the updated entry.
 */
export async function setCacheDescription(name: string, description: string): Promise<CacheMetaEntry> {
	const meta = await readCacheMeta();
	const existing = meta[name];
	meta[name] = {
		description,
		remote: existing?.remote,
		updated: new Date().toISOString(),
	};
	await writeCacheMeta(meta);
	return meta[name];
}

/**
 * Set the remote for a cached repo (called on clone).
 */
export async function setCacheRemote(name: string, remote: string): Promise<void> {
	const meta = await readCacheMeta();
	if (!meta[name]) {
		meta[name] = { description: "", updated: new Date().toISOString() };
	}
	meta[name].remote = remote;
	await writeCacheMeta(meta);
}

/**
 * Remove a cache meta entry.
 */
export async function removeCacheMetaEntry(name: string): Promise<void> {
	const meta = await readCacheMeta();
	delete meta[name];
	await writeCacheMeta(meta);
}

// ─── GitHub API seeding ──────────────────────────────────────────────

/**
 * Fetch the description from the GitHub API for a repo URL.
 * Returns undefined if the URL is not a GitHub repo or the fetch fails.
 */
export async function fetchGitHubDescription(repoUrl: string): Promise<string | undefined> {
	// Extract owner/repo from various GitHub URL formats
	const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/\s#?]+?)(?:\.git)?$/);
	if (!match) return undefined;

	const owner = match[1];
	const repo = match[2];
	const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;

	return new Promise((resolve) => {
		const req = https.get(
			apiUrl,
			{
				headers: { "User-Agent": "pi-reference" },
				timeout: 5000,
			},
			(res) => {
				let data = "";
				res.on("data", (chunk: Buffer) => (data += chunk.toString()));
				res.on("end", () => {
					try {
						const json = JSON.parse(data);
						if (json.description && typeof json.description === "string" && json.description.trim()) {
							resolve(json.description.trim());
						} else {
							resolve(undefined);
						}
					} catch {
						resolve(undefined);
					}
				});
			},
		);

		req.on("error", () => resolve(undefined));
		req.on("timeout", () => {
			req.destroy();
			resolve(undefined);
		});
	});
}

/**
 * Read the first paragraph of a README from a local directory.
 * Returns undefined if no README is found.
 */
export function readReadmeDescription(dirPath: string): string | undefined {
	const readmeNames = ["README.md", "README.txt", "README", "readme.md"];
	for (const name of readmeNames) {
		const p = path.join(dirPath, name);
		if (fs.existsSync(p)) {
			try {
				const content = fs.readFileSync(p, "utf-8");
				// Get first non-empty, non-heading paragraph
				const lines = content.split("\n");
				const paragraphLines: string[] = [];
				let started = false;

				for (const line of lines) {
					const trimmed = line.trim();
					// Skip title heading
					if (!started && trimmed.startsWith("#")) continue;
					// Skip blank lines before content
					if (!started && !trimmed) continue;
					// Start collecting
					if (trimmed) {
						started = true;
						// Stop at next heading or horizontal rule
						if (trimmed.startsWith("#") || trimmed === "---" || trimmed === "***") break;
						paragraphLines.push(trimmed);
					} else if (started) {
						// Blank line after content = end of paragraph
						break;
					}
				}

				const paragraph = paragraphLines.join(" ").trim();
				if (paragraph) return paragraph.slice(0, 300);
			} catch {
				continue;
			}
		}
	}
	return undefined;
}

/**
 * Proactively seed a description for a repo.
 * Tries GitHub API first, then falls back to local README, then returns undefined.
 */
export async function seedDescription(repoUrl: string, localPath: string): Promise<string | undefined> {
	// Try GitHub API
	const ghDescription = await fetchGitHubDescription(repoUrl);
	if (ghDescription && ghDescription.length > 5) return ghDescription;

	// Fallback: local README
	return readReadmeDescription(localPath);
}
