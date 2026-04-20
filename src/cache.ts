import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CACHE_DIR } from "./constants";
import { isGitRepo, runGit, formatSize, formatDirSize, getDirSize } from "./helpers";

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
	const pull = runGit(["pull", "--ff-only"], cachePath);
	if (pull.code !== 0) {
		return { success: false, message: `Update failed: ${pull.stderr || pull.stdout}` };
	}
	return { success: true, message: `Updated ${name}: ${pull.stdout || "already up to date"}` };
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
