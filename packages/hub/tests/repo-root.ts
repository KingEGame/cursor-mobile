import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checkout this suite runs from (any machine: PC, node1 runner, worktree).
 * Tests bind the Hub workspace here instead of a hardcoded PC path, which
 * only exists on the operator PC and made CI elsewhere fail with EMPTY_WORKSPACE.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
