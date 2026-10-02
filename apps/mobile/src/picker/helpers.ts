/**
 * Phase 3 file-picker helpers — debounce, breadcrumbs, multi-root labels.
 * Pure functions (no React) so unit tests stay Node-friendly.
 */

import type { WorkspaceFileItem, WorkspaceRoot } from '../hub/types';

export const FILE_SEARCH_DEBOUNCE_MS = 300;

export interface BreadcrumbSegment {
  /** Display label for this hop */
  label: string;
  /** Relative path to this hop ('' for workspace root) */
  path: string;
}

/**
 * Generic trailing debounce. Returns a cancelable wrapper.
 * `waitMs` defaults to FILE_SEARCH_DEBOUNCE_MS for Hub `q=` search.
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  waitMs: number = FILE_SEARCH_DEBOUNCE_MS,
): ((...args: TArgs) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const wrapped = ((...args: TArgs) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  }) as ((...args: TArgs) => void) & { cancel: () => void };

  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return wrapped;
}

/**
 * Split a posix-style relative path into breadcrumb segments.
 * Empty / root → single "Workspace" hop with path ''.
 */
export function pathBreadcrumbs(
  relativePath: string,
  rootLabel = 'Workspace',
): BreadcrumbSegment[] {
  const trimmed = relativePath.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  const segments: BreadcrumbSegment[] = [{ label: rootLabel, path: '' }];
  if (!trimmed) return segments;

  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

/** Human root chip label; falls back to basename of path. */
export function rootDisplayName(root: WorkspaceRoot): string {
  if (root.name?.trim()) return root.name.trim();
  const parts = root.path.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || root.path;
}

/**
 * Map a workspace root to Hub `GET /workspace/files?root=` filter.
 * - Primary workspace path → omit filter
 * - Nested under primary → relative subpath
 * - Sibling / multi-root → root name (Hub matches by name) or absolute path
 */
export function rootQueryForHub(
  root: WorkspaceRoot | null | undefined,
  workspacePath: string,
): string | undefined {
  if (!root) return undefined;
  const ws = normalizeAbs(workspacePath);
  const rp = normalizeAbs(root.path);
  if (rp === ws) return undefined;
  if (rp.startsWith(ws + '/')) {
    return rp.slice(ws.length + 1);
  }
  // Sibling root (or outside primary): Hub matches root.name or absolute path.
  if (root.name?.trim()) return root.name.trim();
  return rp;
}

/**
 * Stable attachment key for Hub POST attachments / create.
 * Multi-root sibling files use `rootName:relative/path` so Hub can validate
 * under the correct bound root (FR-055).
 */
export function attachmentPathForItem(
  item: Pick<WorkspaceFileItem, 'path' | 'rootPath'>,
  roots: WorkspaceRoot[],
  workspacePath: string,
): string {
  const ws = normalizeAbs(workspacePath);
  const itemRoot = normalizeAbs(item.rootPath);
  if (roots.length <= 1 || itemRoot === ws) {
    return item.path;
  }
  const hit = roots.find((r) => normalizeAbs(r.path) === itemRoot);
  const name = hit ? rootDisplayName(hit) : basenamePath(item.rootPath);
  return `${name}:${item.path}`;
}

function normalizeAbs(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Label for a file row when multi-root: match item.rootPath to workspace.roots.
 */
export function matchRootLabel(
  item: Pick<WorkspaceFileItem, 'rootPath'>,
  roots: WorkspaceRoot[],
): string | null {
  if (roots.length <= 1) return null;
  const hit = roots.find((r) => normalizeAbs(r.path) === normalizeAbs(item.rootPath));
  return hit ? rootDisplayName(hit) : basenamePath(item.rootPath);
}

function basenamePath(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** Row title: short path; optional root prefix when multi-root. */
export function formatPickerRowLabel(
  item: WorkspaceFileItem,
  roots: WorkspaceRoot[],
): { title: string; subtitle: string | null } {
  const rootLabel = matchRootLabel(item, roots);
  return {
    title: item.path,
    subtitle: rootLabel ? `Root: ${rootLabel}` : null,
  };
}

/** Toggle path in a multi-select attachment list (immutable). */
export function toggleAttachment(selected: string[], path: string): string[] {
  return selected.includes(path)
    ? selected.filter((p) => p !== path)
    : [...selected, path];
}

/** Join browse directory + child name into a relative path. */
export function joinRelative(dir: string, name: string): string {
  const d = dir.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  const n = name.replace(/^[/\\]+/, '');
  if (!d) return n;
  if (!n) return d;
  return `${d}/${n}`;
}
