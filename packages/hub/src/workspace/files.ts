/**
 * Workspace file search + attach path validation under bound roots.
 * Scans Hub-reported workspace roots (PC-open project); not a Cursor @-mention index via CDP.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export interface WorkspaceRootRef {
  name: string;
  path: string;
}

export interface WorkspaceFileItem {
  path: string;
  rootPath: string;
  kind: "file" | "dir";
  sizeBytes?: number;
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".expo",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "android",
  "ios",
]);

const MAX_WALK_FILES = 5000;

export function searchWorkspaceFiles(opts: {
  /** Bound workspace roots (PC-open project). */
  roots: WorkspaceRootRef[];
  /**
   * Legacy single-root path. Used only when `roots` is empty.
   * Prefer passing `roots` from Hub workspace snapshot.
   */
  rootPath?: string;
  q?: string;
  /** Root name, absolute root path, or relative path under the primary root. */
  rootFilter?: string;
  limit?: number;
  cursor?: string | null;
}): { items: WorkspaceFileItem[]; nextCursor: string | null } {
  const limit = clampLimit(opts.limit);
  const offset = decodeCursor(opts.cursor);
  const query = (opts.q ?? "").trim().toLowerCase();

  const roots = normalizeRoots(opts.roots, opts.rootPath);
  if (roots.length === 0) {
    return { items: [], nextCursor: null };
  }

  const scanTargets = selectScanTargets(roots, opts.rootFilter);
  if (scanTargets.length === 0) {
    return { items: [], nextCursor: null };
  }

  const collected: WorkspaceFileItem[] = [];
  for (const target of scanTargets) {
    if (collected.length >= MAX_WALK_FILES) break;
    walk(target.scanDir, target.rootPath, collected, query);
  }

  const slice = collected.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const nextCursor =
    nextOffset < collected.length ? encodeCursor(nextOffset) : null;

  return { items: slice, nextCursor };
}

function normalizeRoots(
  roots: WorkspaceRootRef[] | undefined,
  rootPath: string | undefined,
): WorkspaceRootRef[] {
  if (roots && roots.length > 0) {
    return roots.map((r) => ({
      name: r.name?.trim() || basename(resolve(r.path)),
      path: resolve(r.path),
    }));
  }
  if (rootPath && rootPath.trim()) {
    const abs = resolve(rootPath);
    return [{ name: basename(abs), path: abs }];
  }
  return [];
}

export interface WorkspaceScanTarget {
  /** Directory to start walking. */
  scanDir: string;
  /** Bound root path reported on each item (may differ from scanDir for nested filters). */
  rootPath: string;
  name: string;
}

/**
 * Resolve which roots/dirs to scan for `?root=` filter.
 * Fail-closed: unknown / escaping filters → empty list.
 */
export function selectScanTargets(
  roots: WorkspaceRootRef[],
  rootFilter?: string,
): WorkspaceScanTarget[] {
  if (!rootFilter || !rootFilter.trim()) {
    return roots.map((r) => ({
      scanDir: r.path,
      rootPath: r.path,
      name: r.name,
    }));
  }
  const filter = rootFilter.trim();
  const byName = roots.find((r) => r.name === filter);
  if (byName) {
    return [
      { scanDir: byName.path, rootPath: byName.path, name: byName.name },
    ];
  }

  const filterAbs = resolve(filter);
  const byAbs = roots.find((r) => resolve(r.path) === filterAbs);
  if (byAbs) {
    return [
      { scanDir: byAbs.path, rootPath: byAbs.path, name: byAbs.name },
    ];
  }

  // Legacy: relative under primary (first) root — must stay inside that root.
  const primary = roots[0]!;
  const candidate = resolve(primary.path, filter);
  if (!isPathInsideRoot(candidate, primary.path)) {
    return [];
  }
  // Nested filter: walk subdirectory but keep item.rootPath = primary.
  return [
    {
      scanDir: candidate,
      rootPath: primary.path,
      name: primary.name,
    },
  ];
}

/** @deprecated Prefer selectScanTargets — kept for call-site clarity in tests. */
export function selectRootsForFilter(
  roots: WorkspaceRootRef[],
  rootFilter?: string,
): WorkspaceRootRef[] {
  return selectScanTargets(roots, rootFilter).map((t) => ({
    name: t.name,
    path: t.rootPath,
  }));
}

function walk(
  dir: string,
  rootPath: string,
  out: WorkspaceFileItem[],
  query: string,
): void {
  if (out.length >= MAX_WALK_FILES) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_WALK_FILES) return;
    const name = entry.name;
    if (name === "." || name === "..") continue;
    if (entry.isDirectory() && SKIP_DIR_NAMES.has(name)) continue;
    if (name.startsWith(".") && entry.isDirectory()) continue;

    const abs = join(dir, name);
    const rel = toPosix(relative(rootPath, abs));
    if (!rel || rel.startsWith("..")) continue;

    if (entry.isDirectory()) {
      if (!query || rel.toLowerCase().includes(query)) {
        out.push({ path: rel, rootPath, kind: "dir" });
      }
      walk(abs, rootPath, out, query);
      continue;
    }

    if (entry.isFile()) {
      if (query && !rel.toLowerCase().includes(query)) continue;
      let sizeBytes: number | undefined;
      try {
        sizeBytes = statSync(abs).size;
      } catch {
        sizeBytes = undefined;
      }
      out.push({ path: rel, rootPath, kind: "file", sizeBytes });
    }
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 50;
  return Math.min(200, Math.max(1, Math.floor(raw)));
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor || !cursor.trim()) return 0;
  try {
    const n = Number.parseInt(
      Buffer.from(cursor.trim(), "base64url").toString("utf8"),
      10,
    );
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** True if absPath is rootPath or a descendant. */
export function isPathInsideRoot(absPath: string, rootPath: string): boolean {
  const root = resolve(rootPath);
  const abs = resolve(absPath);
  if (abs === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(prefix);
}

/**
 * Resolve attachment paths under one or more workspace roots.
 * Accepts:
 * - `relative/path` (matched under a root; first unique hit wins)
 * - `rootName:relative/path` (explicit multi-root)
 * - absolute path under a bound root
 *
 * Returns normalized paths: `rel` for primary root, `rootName:rel` otherwise
 * when multiple roots are bound. Invalid / escaping / missing → `invalid`.
 */
export function validateAttachmentPaths(
  rootsOrPath: WorkspaceRootRef[] | string,
  attachments: string[],
): { ok: string[]; invalid: string[] } {
  const roots = Array.isArray(rootsOrPath)
    ? normalizeRoots(rootsOrPath, undefined)
    : normalizeRoots(undefined, rootsOrPath);

  const ok: string[] = [];
  const invalid: string[] = [];

  if (roots.length === 0) {
    return { ok: [], invalid: attachments.map(String) };
  }

  for (const raw of attachments) {
    if (typeof raw !== "string" || !raw.trim()) {
      invalid.push(String(raw));
      continue;
    }
    const normalized = resolveAttachmentAgainstRoots(raw.trim(), roots);
    if (!normalized) {
      invalid.push(raw);
      continue;
    }
    ok.push(normalized);
  }

  return { ok, invalid };
}

function resolveAttachmentAgainstRoots(
  raw: string,
  roots: WorkspaceRootRef[],
): string | null {
  // Explicit rootName:rel
  const colon = raw.indexOf(":");
  if (colon > 0 && !raw.includes("://") && !/^([A-Za-z]):/.test(raw)) {
    const rootName = raw.slice(0, colon).trim();
    const relPart = raw.slice(colon + 1).trim().replace(/^[/\\]+/, "");
    const root = roots.find((r) => r.name === rootName);
    if (!root || !relPart) return null;
    return fileUnderRoot(root, relPart, roots);
  }

  // Absolute path under a bound root
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    const abs = resolve(raw);
    for (const root of roots) {
      if (!isPathInsideRoot(abs, root.path)) continue;
      try {
        const st = statSync(abs);
        if (!st.isFile()) return null;
      } catch {
        return null;
      }
      const rel = toPosix(relative(root.path, abs));
      return formatAttachmentKey(root, rel, roots);
    }
    return null;
  }

  // Relative — try each root; prefer unique match, else first existing file.
  const trimmed = raw.replace(/^[/\\]+/, "");
  const hits: string[] = [];
  for (const root of roots) {
    const key = fileUnderRoot(root, trimmed, roots);
    if (key) hits.push(key);
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0]!;
  // Ambiguous across roots — require rootName: prefix
  return null;
}

function fileUnderRoot(
  root: WorkspaceRootRef,
  relativePath: string,
  allRoots: WorkspaceRootRef[],
): string | null {
  const abs = resolve(root.path, relativePath);
  if (!isPathInsideRoot(abs, root.path)) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  const rel = toPosix(relative(root.path, abs));
  return formatAttachmentKey(root, rel, allRoots);
}

function formatAttachmentKey(
  root: WorkspaceRootRef,
  rel: string,
  allRoots: WorkspaceRootRef[],
): string {
  if (allRoots.length <= 1) return rel;
  const primary = allRoots[0]!;
  if (resolve(root.path) === resolve(primary.path)) return rel;
  return `${root.name}:${rel}`;
}

/** Default max bytes for optional Phase 3 text preview (FR-070). */
export const DEFAULT_PREVIEW_MAX_BYTES = 64 * 1024;

export interface WorkspaceFilePreview {
  path: string;
  rootPath: string;
  sizeBytes: number;
  truncated: boolean;
  encoding: "utf8";
  content: string;
  binary: boolean;
  note?: string;
}

/**
 * Read a text preview of a file under bound workspace roots.
 * Rejects path escape; marks likely-binary / oversized as truncated stub.
 */
export function readWorkspaceFilePreview(opts: {
  roots?: WorkspaceRootRef[];
  /** Legacy single root. */
  rootPath?: string;
  relativePath: string;
  maxBytes?: number;
}): WorkspaceFilePreview {
  const maxBytes = opts.maxBytes ?? DEFAULT_PREVIEW_MAX_BYTES;
  const roots = normalizeRoots(opts.roots, opts.rootPath);
  if (roots.length === 0) {
    throw new Error("EMPTY_PATH");
  }

  const trimmed = opts.relativePath.trim();
  if (!trimmed) {
    throw new Error("EMPTY_PATH");
  }

  const resolved = resolvePreviewPath(trimmed, roots);
  if (!resolved) {
    // Distinguish escape vs missing: if any root would place path outside → outside
    if (looksLikeEscape(trimmed, roots)) {
      throw new Error("PATH_OUTSIDE_ROOT");
    }
    throw new Error("FILE_NOT_FOUND");
  }

  const { abs, root, rel } = resolved;
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error("FILE_NOT_FOUND");
  }
  if (!st.isFile()) {
    throw new Error("NOT_A_FILE");
  }

  const sizeBytes = st.size;
  const readLen = Math.min(sizeBytes, maxBytes);
  let buf: Buffer;
  try {
    buf = readFileSync(abs).subarray(0, readLen);
  } catch {
    throw new Error("READ_FAILED");
  }

  const binary = looksBinary(buf);
  if (binary) {
    return {
      path: rel,
      rootPath: root.path,
      sizeBytes,
      truncated: true,
      encoding: "utf8",
      content: "",
      binary: true,
      note: "Binary or non-text file — open on the PC in Cursor.",
    };
  }

  const truncated = sizeBytes > maxBytes;
  return {
    path: rel,
    rootPath: root.path,
    sizeBytes,
    truncated,
    encoding: "utf8",
    content: buf.toString("utf8"),
    binary: false,
    note: truncated
      ? `Preview truncated to ${maxBytes} bytes (optional Phase 3 editor).`
      : undefined,
  };
}

function resolvePreviewPath(
  raw: string,
  roots: WorkspaceRootRef[],
): { abs: string; root: WorkspaceRootRef; rel: string } | null {
  const colon = raw.indexOf(":");
  if (colon > 0 && !raw.includes("://") && !/^([A-Za-z]):/.test(raw)) {
    const rootName = raw.slice(0, colon).trim();
    const relPart = raw.slice(colon + 1).trim().replace(/^[/\\]+/, "");
    const root = roots.find((r) => r.name === rootName);
    if (!root || !relPart) return null;
    const abs = resolve(root.path, relPart);
    if (!isPathInsideRoot(abs, root.path)) return null;
    return { abs, root, rel: toPosix(relative(root.path, abs)) };
  }

  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    const abs = resolve(raw);
    for (const root of roots) {
      if (!isPathInsideRoot(abs, root.path)) continue;
      return { abs, root, rel: toPosix(relative(root.path, abs)) };
    }
    return null;
  }

  const trimmed = raw.replace(/^[/\\]+/, "");
  for (const root of roots) {
    const abs = resolve(root.path, trimmed);
    if (!isPathInsideRoot(abs, root.path)) continue;
    try {
      if (statSync(abs).isFile()) {
        return { abs, root, rel: toPosix(relative(root.path, abs)) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function looksLikeEscape(raw: string, roots: WorkspaceRootRef[]): boolean {
  if (raw.includes("..")) {
    for (const root of roots) {
      const abs = resolve(root.path, raw.replace(/^[/\\]+/, ""));
      if (!isPathInsideRoot(abs, root.path)) return true;
    }
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    const abs = resolve(raw);
    return !roots.some((r) => isPathInsideRoot(abs, r.path));
  }
  return false;
}

function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}
