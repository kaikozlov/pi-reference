import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CACHE_DIR, BRANCH_FALLBACKS } from "./constants";
import { getRefDir, ensureRefDir, isGitRepo, runGit, extractRepoName } from "./helpers";
import { createSidecar, deleteSidecar, type SidecarFrontmatter } from "./sidecar";
import { getCacheMetaEntry, setCacheRemote, setCacheBranch, setCacheSearchPaths, seedDescription } from "./cache-meta";
import { validateGitUrl, validateBranchName, validateEntryName, validateSearchPaths } from "./validation";

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

	// Validate inputs
	const urlValidation = validateGitUrl(url);
	if (!urlValidation.ok) return { success: false, message: urlValidation.error };

	if (optBranch) {
		const branchValidation = validateBranchName(optBranch);
		if (!branchValidation.ok) return { success: false, message: branchValidation.error };
	}

	if (optName) {
		const nameValidation = validateEntryName(optName);
		if (!nameValidation.ok) return { success: false, message: nameValidation.error };
	}

	if (paths.length > 0) {
		const pathsValidation = validateSearchPaths(paths);
		if (!pathsValidation.ok) return { success: false, message: pathsValidation.error };
	}

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

	// Validate entry name if provided
	if (name) {
		const { validateEntryName } = await import("./validation");
		const nameValidation = validateEntryName(name);
		if (!nameValidation.ok) return { success: false, message: nameValidation.error };
	}

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

// ─── npm package entries ──────────────────────────────────────────────

function parseNpmRef(ref: string): { pkg: string; version?: string } | null {
	// npm:package@version or npm:package
	const withoutPrefix = ref.startsWith("npm:") ? ref.slice(4) : ref;
	if (!withoutPrefix) return null;

	const lastAt = withoutPrefix.lastIndexOf("@");
	if (lastAt > 0) {
		// Scoped: @scope/pkg@version or regular: pkg@version
		return { pkg: withoutPrefix.slice(0, lastAt), version: withoutPrefix.slice(lastAt + 1) };
	}
	return { pkg: withoutPrefix };
}

export async function addNpmPackage(cwd: string, ref: string, name?: string): Promise<{ success: boolean; message: string }> {
	await ensureRefDir(cwd);

	const parsed = parseNpmRef(ref);
	if (!parsed) {
		return { success: false, message: "Invalid npm reference. Use npm:<package> or npm:<package>@<version>" };
	}

	const { pkg, version } = parsed;
	const targetName = name || pkg.replace("@", "").replace("/", "-");
	const cachePath = path.join(CACHE_DIR, `npm-${targetName}`);
	const targetPath = path.join(getRefDir(cwd), targetName);

	if (fs.existsSync(targetPath)) {
		return { success: false, message: `${targetName} already exists in REFERENCE/` };
	}

	// Validate name
	const { validateEntryName } = await import("./validation");
	const nameValidation = validateEntryName(targetName);
	if (!nameValidation.ok) return { success: false, message: nameValidation.error };

	// Download and extract npm package
	await fsp.mkdir(CACHE_DIR, { recursive: true });

	const packSpec = version ? `${pkg}@${version}` : pkg;
	const tmpDir = path.join(CACHE_DIR, `.tmp-npm-${targetName}`);

	try {
		// Clean up any previous temp
		if (fs.existsSync(tmpDir)) await fsp.rm(tmpDir, { recursive: true });
		await fsp.mkdir(tmpDir, { recursive: true });

		// npm pack to get the tarball
		const packResult = Bun.spawnSync(["npm", "pack", packSpec, "--pack-destination", tmpDir], {
			encoding: "utf-8",
			timeout: 60_000,
		});

		if (packResult.status !== 0) {
			return { success: false, message: `npm pack failed: ${packResult.stderr || "unknown error"}` };
		}

		// Find the tarball
		const tmpFiles = fs.readdirSync(tmpDir);
		const tarball = tmpFiles.find((f) => f.endsWith(".tgz"));
		if (!tarball) {
			return { success: false, message: "npm pack did not produce a tarball" };
		}

		// Clean up old cache if exists
		if (fs.existsSync(cachePath)) {
			await fsp.rm(cachePath, { recursive: true });
		}

		// Extract to cache dir
		await fsp.mkdir(cachePath, { recursive: true });
		const extractResult = Bun.spawnSync(["tar", "-xzf", path.join(tmpDir, tarball), "-C", cachePath], {
			encoding: "utf-8",
			timeout: 30_000,
		});

		if (extractResult.status !== 0) {
			return { success: false, message: `tar extract failed: ${extractResult.stderr || "unknown error"}` };
		}

		// npm tarballs extract into a 'package/' subdirectory — move contents up
		const packageDir = path.join(cachePath, "package");
		if (fs.existsSync(packageDir)) {
			const tmpMove = path.join(cachePath, ".tmp-move");
			await fsp.rename(packageDir, tmpMove);
			// Remove anything else in cachePath
			for (const entry of fs.readdirSync(cachePath)) {
				if (entry !== ".tmp-move") {
					await fsp.rm(path.join(cachePath, entry), { recursive: true });
				}
			}
			// Move contents up
			for (const entry of fs.readdirSync(tmpMove)) {
				await fsp.rename(path.join(tmpMove, entry), path.join(cachePath, entry));
			}
			await fsp.rm(tmpMove, { recursive: true });
		}
	} finally {
		// Clean up temp
		if (fs.existsSync(tmpDir)) await fsp.rm(tmpDir, { recursive: true });
	}

	// Symlink or copy from cache
	let linked = false;
	try {
		await fsp.symlink(cachePath, targetPath);
		linked = true;
	} catch {
		await fsp.cp(cachePath, targetPath, { recursive: true });
	}

	// Read package.json for description
	let description: string | undefined;
	try {
		const pkgJson = JSON.parse(fs.readFileSync(path.join(cachePath, "package.json"), "utf-8"));
		description = pkgJson.description;
	} catch { /* skip */ }

	// Create sidecar
	const fm: SidecarFrontmatter = {
		entry: targetName,
		type: "npm",
		npmPackage: pkg,
		npmVersion: version,
		description,
	};
	await createSidecar(cwd, targetName, fm);

	// Update cache meta
	const { setCacheDescription: setDesc } = await import("./cache-meta");
	const meta = await import("./cache-meta");
	await meta.setCacheRemote?.(targetName, `npm:${pkg}`);
	if (description) await setDesc(targetName, description);

	return { success: true, message: `Added ${targetName} (npm: ${packSpec}, ${linked ? "linked from cache" : "copied"})` };
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
