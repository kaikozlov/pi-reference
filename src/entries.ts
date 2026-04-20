import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CACHE_DIR } from "./constants";
import { getRefDir, ensureRefDir, isGitRepo, runGit, extractRepoName } from "./helpers";

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

	try {
		await fsp.symlink(cachePath, targetPath);
		return { success: true, message: `Added ${repoName} (linked from cache)` };
	} catch {
		await fsp.cp(cachePath, targetPath, { recursive: true });
		return { success: true, message: `Added ${repoName} (copied from cache)` };
	}
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

	return { success: true, message: `Removed ${name} from REFERENCE/` };
}
