import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";

export const REFERENCE_DIR = "REFERENCE";
export const SIDECAR_DIR = "sidecar";
export const INDEX_FILE = "REFERENCE_INDEX.md";

const DATA_DIR = path.join(getAgentDir(), "extensions", "data", "pi-reference");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const CACHE_META_FILE = path.join(DATA_DIR, "cache-meta.json");
export const DEFAULT_TREE_DEPTH = 2;
export const MAX_ITEMS_PER_DIR = 10; // show first N children, then "... and N more"
export const BRANCH_FALLBACKS = ["main", "master", "trunk", "dev"] as const;

// ── One-shot migration from legacy paths ────────────────────────────────
let migrationDone = false;

export function migrateFromLegacyPaths(): void {
	if (migrationDone) return;
	migrationDone = true;

	const agentDir = getAgentDir();
	const legacyCacheDir = path.join(agentDir, "..", "..", "reference", "cache");
	const legacyCacheMeta = path.join(agentDir, "..", "..", "reference", "cache-meta.json");

	// Resolve to absolute paths
	const resolvedCacheDir = path.resolve(legacyCacheDir);
	const resolvedCacheMeta = path.resolve(legacyCacheMeta);

	try {
		// Migrate cache-meta.json
		if (existsSync(resolvedCacheMeta) && !existsSync(CACHE_META_FILE)) {
			mkdirSync(DATA_DIR, { recursive: true });
			renameSync(resolvedCacheMeta, CACHE_META_FILE);
		}

		// Migrate cache directory
		if (existsSync(resolvedCacheDir) && !existsSync(CACHE_DIR)) {
			mkdirSync(DATA_DIR, { recursive: true });
			renameSync(resolvedCacheDir, CACHE_DIR);
		}
	} catch {
		// Migration is best-effort; don't block startup
	}
}

// Run migration eagerly on module load
migrateFromLegacyPaths();
