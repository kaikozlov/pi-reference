import * as path from "node:path";
import * as os from "node:os";

export const REFERENCE_DIR = "REFERENCE";
export const SIDECAR_DIR = "sidecar";
export const INDEX_FILE = "REFERENCE_INDEX.md";
export const CACHE_DIR = path.join(os.homedir(), ".pi", "reference", "cache");
export const CACHE_META_FILE = path.join(os.homedir(), ".pi", "reference", "cache-meta.json");
export const DEFAULT_TREE_DEPTH = 2;
export const MAX_ITEMS_PER_DIR = 10; // show first N children, then "... and N more"
