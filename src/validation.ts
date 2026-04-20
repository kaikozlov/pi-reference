// ─── Validation helpers ───────────────────────────────────────────────
// Lightweight guard functions inspired by btca's Zod schemas.
// Returns { ok: true } or { ok: false, error: string }.

export type ValidationResult = { ok: true } | { ok: false; error: string };

function fail(error: string): ValidationResult {
	return { ok: false, error };
}

function ok(): ValidationResult {
	return { ok: true };
}

// ─── Git URL ──────────────────────────────────────────────────────────

const PRIVATE_IP_REGEX =
	/^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|::1|0\.0\.0\.0)$/;

/**
 * Validate a git URL. Accepts HTTPS, git@, ssh://, and git:// URLs.
 * Rejects: embedded credentials, localhost/private IPs (for HTTPS only).
 */
export function validateGitUrl(url: string): ValidationResult {
	if (!url || url.trim().length === 0) {
		return fail("Git URL cannot be empty");
	}

	// Check for common git URL schemes
	const isHttps = url.startsWith("https://");
	const isSsh = url.startsWith("git@") || url.startsWith("ssh://");
	const isGitProto = url.startsWith("git://");

	if (!isHttps && !isSsh && !isGitProto) {
		return fail("Git URL must start with https://, git@, ssh://, or git://");
	}

	// HTTPS-specific checks
	if (isHttps) {
		try {
			const parsed = new URL(url);

			// No embedded credentials
			if (parsed.username || parsed.password) {
				return fail("Git URL must not contain embedded credentials (user:pass@)");
			}

			// No localhost / private IPs
			const hostname = parsed.hostname.toLowerCase();
			if (
				hostname === "localhost" ||
				PRIVATE_IP_REGEX.test(hostname)
			) {
				return fail("Git URL must not point to localhost or a private IP address");
			}
		} catch {
			return fail("Git URL is not a valid URL");
		}
	}

	return ok();
}

// ─── Branch name ─────────────────────────────────────────────────────

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.-]+$/;
const BRANCH_NAME_MAX = 128;

/**
 * Validate a git branch name.
 * Allows: alphanumeric, forward slashes, dots, underscores, hyphens.
 * Rejects: starting with `-` (git option injection), spaces, max 128 chars.
 */
export function validateBranchName(branch: string): ValidationResult {
	if (!branch || branch.trim().length === 0) {
		return fail("Branch name cannot be empty");
	}
	if (branch.length > BRANCH_NAME_MAX) {
		return fail(`Branch name too long: ${branch.length} chars (max ${BRANCH_NAME_MAX})`);
	}
	if (branch.startsWith("-")) {
		return fail(`Branch name must not start with '-' (prevents git option injection)`);
	}
	if (!BRANCH_NAME_REGEX.test(branch)) {
		return fail(
			"Branch name must contain only alphanumeric characters, /, _, -, and .",
		);
	}
	return ok();
}

// ─── Search path ─────────────────────────────────────────────────────

const SEARCH_PATH_MAX = 256;

/**
 * Validate a sparse checkout search path.
 * Must be a relative path within the repo. No `..`, no absolute paths.
 */
export function validateSearchPath(searchPath: string): ValidationResult {
	if (!searchPath || searchPath.trim().length === 0) {
		return fail("Search path cannot be empty");
	}
	if (searchPath.length > SEARCH_PATH_MAX) {
		return fail(`Search path too long: ${searchPath.length} chars (max ${SEARCH_PATH_MAX})`);
	}
	if (searchPath.includes("..")) {
		return fail('Search path must not contain ".." (path traversal)');
	}
	if (searchPath.includes("\n") || searchPath.includes("\r")) {
		return fail("Search path must not contain newlines");
	}
	if (searchPath.startsWith("/") || searchPath.match(/^[a-zA-Z]:\\/)) {
		return fail("Search path must be a relative path, not absolute");
	}
	return ok();
}

// ─── Entry name ──────────────────────────────────────────────────────

const ENTRY_NAME_REGEX = /^@?[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
const ENTRY_NAME_MAX = 64;

/**
 * Validate an entry name (used for --as, cache entries, etc.).
 * Must start with a letter or @. No `..`, no `//`, no trailing `/`.
 */
export function validateEntryName(name: string): ValidationResult {
	if (!name || name.trim().length === 0) {
		return fail("Entry name cannot be empty");
	}
	if (name.length > ENTRY_NAME_MAX) {
		return fail(`Entry name too long: ${name.length} chars (max ${ENTRY_NAME_MAX})`);
	}
	if (!ENTRY_NAME_REGEX.test(name)) {
		return fail(
			"Entry name must start with a letter or @ and contain only letters, numbers, ., _, -, and /",
		);
	}
	if (name.includes("..")) {
		return fail('Entry name must not contain ".."');
	}
	if (name.includes("//")) {
		return fail('Entry name must not contain "//"');
	}
	if (name.endsWith("/")) {
		return fail('Entry name must not end with "/"');
	}
	return ok();
}

// ─── Validate multiple ───────────────────────────────────────────────

/**
 * Validate an array of search paths, returning all errors or ok.
 */
export function validateSearchPaths(paths: string[]): ValidationResult {
	for (const p of paths) {
		const result = validateSearchPath(p);
		if (!result.ok) return result;
	}
	return ok();
}
