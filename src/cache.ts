import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CACHE_DIR } from "./constants";
import { isGitRepo, runGit, formatSize, formatDirSize, getDirSize } from "./helpers";
import { getCacheMetaEntry } from "./cache-meta";

// ─── Cache management ────────────────────────────────────────────────

export function listCache(): { name: string; size: string; isGit: boolean; remote: string }[] {
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

export function getCacheSize(): string {
	if (!fs.existsSync(CACHE_DIR)) return "0B";
	return formatSize(getDirSize(CACHE_DIR));
}

export async function updateCacheEntry(name: string): Promise<{ success: boolean; message: string }> {
	const cachePath = path.join(CACHE_DIR, name);
	if (!fs.existsSync(cachePath)) {
		return { success: false, message: `${name} not found in cache` };
	}
	if (!isGitRepo(cachePath)) {
		return { success: false, message: `${name} is not a git repo, nothing to update` };
	}

	// Read branch from cache meta, default to main
	const meta = await getCacheMetaEntry(name);
	const branch = meta?.branch || "main";

	// Shallow fetch + hard reset
	const fetch = runGit(["fetch", "--depth", "1", "origin", branch], cachePath);
	if (fetch.code !== 0) {
		// If the branch doesn't exist, try fallback branches
		if (meta?.branch) {
			// User-specified branch failed
			return { success: false, message: `Update failed (branch ${branch}): ${fetch.stderr || fetch.stdout}` };
		}
		// Try common branches
		const BRANCH_FALLBACKS = ["main", "master", "trunk", "dev"];
		for (const fallback of BRANCH_FALLBACKS) {
			const retry = runGit(["fetch", "--depth", "1", "origin", fallback], cachePath);
			if (retry.code === 0) {
				runGit(["reset", "--hard", `origin/${fallback}`], cachePath);
				// Re-apply sparse checkout if needed
				if (meta?.searchPaths && meta.searchPaths.length > 0) {
					runGit(["sparse-checkout", "set", ...meta.searchPaths], cachePath);
				}
				return { success: true, message: `Updated ${name} (branch: ${fallback}): fetch+reset successful` };
			}
		}
		return { success: false, message: `Update failed: ${fetch.stderr || fetch.stdout}` };
	}

	const reset = runGit(["reset", "--hard", `origin/${branch}`], cachePath);
	if (reset.code !== 0) {
		return { success: false, message: `Reset failed: ${reset.stderr || reset.stdout}` };
	}

	// Re-apply sparse checkout if configured
	if (meta?.searchPaths && meta.searchPaths.length > 0) {
		runGit(["sparse-checkout", "set", ...meta.searchPaths], cachePath);
	}

	return { success: true, message: `Updated ${name}: fetch+reset successful` };
}

export async function updateAllCache(): Promise<string[]> {
	const entries = listCache().filter((e) => e.isGit);
	const results: string[] = [];
	for (const entry of entries) {
		const r = await updateCacheEntry(entry.name);
		results.push(r.message);
	}
	return results;
}

export async function removeCacheEntry(name: string): Promise<{ success: boolean; message: string }> {
	const cachePath = path.join(CACHE_DIR, name);
	if (!fs.existsSync(cachePath)) {
		return { success: false, message: `${name} not found in cache` };
	}
	await fsp.rm(cachePath, { recursive: true });
	return { success: true, message: `Removed ${name} from cache` };
}

export async function clearCache(): Promise<{ removed: number; freed: string }> {
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
