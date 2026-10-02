import { softDecode } from './pair-deep-link';
import type { RootStackParamList } from './types';

export type NewSessionDeepLinkParams = NonNullable<RootStackParamList['NewSession']>;

/**
 * Parse `cursor-companion://new?...` (or path `new?...`) into stack params.
 * Returns null when the URL is not a new-session deep link.
 *
 * Query keys (adb UAT — avoid controlled TextInput):
 *   prompt   first Composer prompt (required for auto-create evidence)
 *   model    Hub model id (optional; default chip still applies)
 *   attach   workspace file path; repeat `attach=` for multi-attach
 *   auto     `1` → create once sheet is ready (default when prompt present)
 */
export function parseNewSessionDeepLink(
  url: string | null | undefined,
): NewSessionDeepLinkParams | null {
  if (!url) return null;
  const trimmed = url.trim();
  const full =
    /^cursor-companion:\/\/\/?new\/?(?:\?(.*))?$/i.exec(trimmed) ||
    /^cursor-companion:\/\/\/?new\?(.*)$/i.exec(trimmed);
  const pathOnly = !full
    ? /^new\/?\?(.*)$/i.exec(trimmed) || /^new\/?(?:\?(.*))?$/i.exec(trimmed)
    : null;
  const match = full || pathOnly;
  if (!match) return null;

  // Bare `new` / `new/` → empty params (open sheet only).
  if (!match[1] && !/[?&]/.test(trimmed)) {
    return {};
  }
  const qs = match[1] || '';
  if (!qs && !trimmed.includes('?')) {
    return {};
  }

  const sp = new URLSearchParams(qs);
  const params: NewSessionDeepLinkParams = {};

  const prompt = sp.get('prompt');
  if (prompt != null && prompt !== '') {
    params.prompt = softDecode(prompt);
  }
  const model = sp.get('model');
  if (model != null && model !== '') {
    params.model = softDecode(model);
  }
  const auto = sp.get('auto');
  if (auto != null && auto !== '') {
    params.auto = softDecode(auto);
  }

  // Prefer repeated attach=; also accept comma-separated attach for short adb.
  const attaches: string[] = [];
  for (const raw of sp.getAll('attach')) {
    if (!raw) continue;
    if (raw.includes(',') && !raw.startsWith('/')) {
      // unlikely; still split only when no leading slash (paths are absolute)
      for (const part of raw.split(',')) {
        const t = softDecode(part.trim());
        if (t) attaches.push(t);
      }
    } else if (raw.includes(',') && raw.includes('/')) {
      // Absolute paths rarely contain commas — treat whole as one path,
      // but also support explicit comma join of abs paths from builders.
      for (const part of raw.split(',')) {
        const t = softDecode(part.trim());
        if (t) attaches.push(t);
      }
    } else {
      const t = softDecode(raw.trim());
      if (t) attaches.push(t);
    }
  }
  if (attaches.length > 0) {
    params.attach = attaches;
  }

  return params;
}

/** Normalize attach from string | string[] | undefined. */
export function normalizeAttachPaths(
  attach: string | string[] | undefined | null,
): string[] {
  if (!attach) return [];
  if (Array.isArray(attach)) {
    return attach.map((p) => p.trim()).filter(Boolean);
  }
  return attach
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** True when deep link should auto-fire Create (UAT / ops). */
export function isNewSessionAutoCreate(
  params: NewSessionDeepLinkParams | null | undefined,
): boolean {
  if (!params) return false;
  const auto = (params.auto ?? '').trim().toLowerCase();
  if (auto === '0' || auto === 'false' || auto === 'no') return false;
  if (auto === '1' || auto === 'true' || auto === 'yes') return true;
  // Default: auto when a non-empty prompt is injected (adb evidence path).
  return Boolean(params.prompt?.trim());
}

/**
 * Build an adb-safe new-session inject deep link.
 * Sets prompt/model/attach in React state — never relies on RN TextInput + adb.
 */
export function buildNewSessionDeepLink(input: {
  prompt: string;
  model?: string;
  attach?: string[];
  auto?: string;
}): string {
  const qs = new URLSearchParams();
  qs.set('prompt', input.prompt.trim());
  if (input.model?.trim()) {
    qs.set('model', input.model.trim());
  }
  for (const path of input.attach ?? []) {
    const t = path.trim();
    if (t) qs.append('attach', t);
  }
  qs.set('auto', (input.auto ?? '1').trim() || '1');
  return `cursor-companion://new?${qs.toString()}`;
}
