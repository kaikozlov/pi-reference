import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CACHE_DIR } from "./constants";
import { getRefDir, ensureRefDir, isGitRepo, runGit, extractRepoName } from "./helpers";
import { createSidecar, deleteSidecar, type SidecarFrontmatter } from "./sidecar";
import { getCacheMetaEntry, setCacheRemote, seedDescription } from "./cache-meta";

// ─── Add entries ─────────────────────────────────────────────────────

export async function addRepo(cwd: string, url: string, name?: string): Promise<{ success: boolean; message: string }> {
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

	// Record remote in cache meta
	await setCacheRemote(repoName, url);

	let linked = false;
	try {
		await fsp.symlink(cachePath, targetPath);
		linked = true;
	} catch {
		await fsp.cp(cachePath, targetPath, { recursive: true });
	}

	// Proactively seed description
	const cacheEntry = await getCacheMetaEntry(repoName);
	let description = cacheEntry?.description;

	if (!description) {
		description = (await seedDescription(url, cachePath)) ?? undefined;
	}

	// Create sidecar
	const fm: SidecarFrontmatter = {
		entry: repoName,
		type: "git",
		remote: url,
		description,
	};
	await createSidecar(cwd, repoName, fm);

	// If we got a description, write it back to cache meta for future projects
	if (description) {
		const { setCacheDescription } = await import("./cache-meta");
		await setCacheDescription(repoName, description);
	}

	return { success: true, message: `Added ${repoName} (${linked ? "linked from cache" : "copied from cache"})` };
}

export async function addFile(cwd: string, filePath: string, name?: string): Promise<{ success: boolean; message: string }> {
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

	// Create sidecar
	const fm: SidecarFrontmatter = {
		entry: targetName,
		type: stat.isDirectory() ? "directory" : "file",
	};
	await createSidecar(cwd, targetName, fm);

	return { success: true, message: `Added ${targetName} to REFERENCE/` };
}

// ─── Remove entries ──────────────────────────────────────────────────

export async function removeEntry(cwd: string, name: string): Promise<{ success: boolean; message: string }> {
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

	// Remove sidecar
	await deleteSidecar(cwd, name);

	return { success: true, message: `Removed ${name} from REFERENCE/` };
}
