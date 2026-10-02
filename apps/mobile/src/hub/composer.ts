import type { AgentMode, ComposerOptions, MentionOption, MentionRef } from './types';

/** Modes in Cursor's "+" list, with UI-SPEC chip colours and placeholders. */
export const MODES: Array<{ mode: AgentMode; subtitle: string; color: string; placeholder: string }> = [
  { mode: 'Plan', subtitle: 'Generate an implementation plan', color: '#f5d0c5', placeholder: 'Plan changes' },
  { mode: 'Debug', subtitle: 'Pinpoint the root cause', color: '#f5c6cb', placeholder: 'Describe the bug' },
  { mode: 'Multitask', subtitle: 'Orchestrate subagents in parallel', color: '#e4d4f4', placeholder: 'Coordinate tasks' },
  { mode: 'Ask', subtitle: 'Answer without making edits', color: '#cfead6', placeholder: 'Ask a question' },
];

export function modeInfo(mode: AgentMode | null | undefined) {
  return MODES.find((m) => m.mode === mode) ?? null;
}

/** Chip text as the operator sees it in Cursor: "@AGENTS.md", "/goal". */
export function mentionChipLabel(ref: MentionRef): string {
  return `${ref.trigger}${ref.label}`;
}

/** MCP plugins are "@" options whose description says MCP server. */
export function isPluginOption(option: MentionOption): boolean {
  return /mcp server/i.test(option.detail);
}

/** Picker rows the operator can actually use (hide plugins that need setup on the PC). */
export function usableOption(option: MentionOption): boolean {
  return !/needs authentication|error/i.test(option.hint);
}

export function sameMention(a: MentionRef, b: MentionRef): boolean {
  return a.trigger === b.trigger && a.label === b.label && (a.detail ?? '') === (b.detail ?? '');
}

/** A message needs text; chips and photos alone are not sent (Cursor needs a prompt). */
export function canSend(text: string, busy: boolean): boolean {
  return !busy && text.trim().length > 0;
}

/** Only send the options the operator actually set. */
export function composerPayload(state: {
  mode: AgentMode | null;
  model: string | null;
  mentions: MentionRef[];
  images: ComposerOptions['images'];
}): ComposerOptions {
  const out: ComposerOptions = {};
  if (state.mode) out.mode = state.mode;
  if (state.model) out.model = state.model;
  if (state.mentions.length) out.mentions = state.mentions;
  if (state.images && state.images.length) out.images = state.images;
  return out;
}
