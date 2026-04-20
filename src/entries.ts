import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CACHE_DIR, BRANCH_FALLBACKS } from "./constants";
import { getRefDir, ensureRefDir, isGitRepo, runGit, extractRepoName } from "./helpers";
import { createSidecar, deleteSidecar, type SidecarFrontmatter } from "./sidecar";
import { getCacheMetaEntry, setCacheRemote, setCacheBranch, setCacheSearchPaths, seedDescription } from "./cache-meta";

// ─── Add entries ─────────────────────────────────────────────────────

function isBranchNotFoundError(stderr: string): boolean {
	return /could not find remote ref/i.test(stderr)
		|| /Remote branch .* not found/i.test(stderr)
		|| /fatal: invalid refspec/i.test(stderr)
		|| /error: pathspec .* did not match any/i.test(stderr)
		|| /Repository not found/i.test(stderr)
		|| /fatal: repository .* not found/i.test(stderr);
}

function gitClone(url: string, target: string, branch?: string): { code: number; stderr: string } {
	const args = branch
		? ["clone", "-b", branch, url, target]
		: ["clone", url, target];
	const result = runGit(args);
	return { code: result.code, stderr: result.stderr };
}

function gitSparseClone(url: string, target: string, paths: string[], branch?: string): { code: number; stderr: string } {
	// Clone with sparse checkout support
	const cloneArgs = [
		"clone", "--filter=blob:none", "--no-checkout", "--sparse",
		...(branch ? ["-b", branch] : []),
		url, target,
	];
	const cloneResult = runGit(cloneArgs);
	if (cloneResult.code !== 0) return { code: cloneResult.code, stderr: cloneResult.stderr };

	// Set sparse checkout paths
	const sparseResult = runGit(["sparse-checkout", "set", ...paths], target);
	if (sparseResult.code !== 0) return { code: sparseResult.code, stderr: sparseResult.stderr };

	// Checkout
	const checkoutResult = runGit(["checkout"], target);
	return { code: checkoutResult.code, stderr: checkoutResult.stderr };
}

export interface AddRepoOptions {
	name?: string;
	branch?: string;
	paths?: string[];
	ephemeral?: boolean;
}

export async function addRepo(cwd: string, url: string, options: AddRepoOptions = {}): Promise<{ success: boolean; message: string }> {
	const { name: optName, branch: optBranch, paths = [], ephemeral = false } = options;

	if (!ephemeral) {
		await ensureRefDir(cwd);
	}

	const repoName = optName || extractRepoName(url);
	const targetPath = path.join(getRefDir(cwd), repoName);

	if (fs.existsSync(targetPath)) {
		return { success: false, message: `${repoName} already exists in REFERENCE/` };
	}

	// For ephemeral entries, clone directly into REFERENCE/ without cache
	if (ephemeral) {
		await fsp.mkdir(path.dirname(targetPath), { recursive: true });

		let usedBranch = optBranch;
		let lastError = "";

		// Try specified branch, then fallbacks
		const branchesToTry = optBranch
			? [optBranch]
			: [...BRANCH_FALLBACKS];

		for (const branch of branchesToTry) {
			// Clean up failed attempt
			if (fs.existsSync(targetPath)) {
				await fsp.rm(targetPath, { recursive: true });
			}

			const result = paths.length > 0
				? gitSparseClone(url, targetPath, paths, branch)
				: gitClone(url, targetPath, branch);

			if (result.code === 0) {
				usedBranch = branch;
				break;
			}

			lastError = result.stderr;
			if (!isBranchNotFoundError(result.stderr)) break; // Only retry on branch-not-found
		}

		if (!fs.existsSync(targetPath) || !isGitRepo(targetPath)) {
			return { success: false, message: `Clone failed: ${lastError}` };
		}

		// Create minimal sidecar
		const fm: SidecarFrontmatter = {
			entry: repoName,
			type: "git",
			remote: url,
			branch: usedBranch,
			searchPaths: paths.length > 0 ? paths : undefined,
			ephemeral: true,
		};
		await createSidecar(cwd, repoName, fm);

		return { success: true, message: `Added ${repoName} (ephemeral, not cached)` };
	}

	// Cached path
	const cachePath = path.join(CACHE_DIR, repoName);

	if (!fs.existsSync(cachePath)) {
		await fsp.mkdir(CACHE_DIR, { recursive: true });

		let usedBranch = optBranch;
		let lastError = "";

		// Try specified branch, then fallbacks
		const branchesToTry = optBranch
			? [optBranch]
			: [...BRANCH_FALLBACKS];

		for (const branch of branchesToTry) {
			// Clean up failed attempt
			if (fs.existsSync(cachePath)) {
				await fsp.rm(cachePath, { recursive: true });
			}

			const result = paths.length > 0
				? gitSparseClone(url, cachePath, paths, branch)
				: gitClone(url, cachePath, branch);

			if (result.code === 0) {
				usedBranch = branch;
				break;
			}

			lastError = result.stderr;
			if (!isBranchNotFoundError(result.stderr)) break; // Only retry on branch-not-found
		}

		if (!fs.existsSync(cachePath) || !isGitRepo(cachePath)) {
			return { success: false, message: `Clone failed: ${lastError}` };
		}

		// Record metadata in cache
		await setCacheRemote(repoName, url);
		if (usedBranch) await setCacheBranch(repoName, usedBranch);
		if (paths.length > 0) await setCacheSearchPaths(repoName, paths);
	} else {
		// Cache hit — shallow update
		const cachedMeta = await getCacheMetaEntry(repoName);
		const branch = optBranch || cachedMeta?.branch || "main";
		const cachedPaths = cachedMeta?.searchPaths;

		// Shallow fetch + hard reset
		const fetch = runGit(["fetch", "--depth", "1", "origin", branch], cachePath);
		if (fetch.code === 0) {
			runGit(["reset", "--hard", `origin/${branch}`], cachePath);
		}

		// Re-apply sparse checkout if needed
		if (cachedPaths && cachedPaths.length > 0) {
			runGit(["sparse-checkout", "set", ...cachedPaths], cachePath);
		}

		// Update metadata
		if (!cachedMeta?.branch && branch) await setCacheBranch(repoName, branch);
		if (!cachedMeta?.remote) await setCacheRemote(repoName, url);
	}

	// Symlink or copy from cache to REFERENCE/
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
		branch: optBranch || cacheEntry?.branch,
		searchPaths: paths.length > 0 ? paths : undefined,
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
