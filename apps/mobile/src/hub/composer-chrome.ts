/**
 * Composer chrome helpers — Gemini-style: field + send + one “+” overflow.
 * Agent modes are Hub create-session strings; live mid-chat mode change is designed.
 */

export type AgentModeId = 'agent' | 'ask' | 'parallel' | 'multitask' | 'debug';

export interface AgentModeOption {
  id: AgentModeId;
  label: string;
  /** True when Hub createSession accepts this string today. */
  createWired: boolean;
  /** Mid-chat live switch — not a VERIFIED CDP action yet. */
  liveSwitch: 'designed';
}

export const AGENT_MODE_OPTIONS: readonly AgentModeOption[] = [
  { id: 'agent', label: 'Agent', createWired: true, liveSwitch: 'designed' },
  { id: 'ask', label: 'Ask', createWired: true, liveSwitch: 'designed' },
  { id: 'parallel', label: 'Parallel', createWired: true, liveSwitch: 'designed' },
  { id: 'multitask', label: 'Multitask', createWired: true, liveSwitch: 'designed' },
  { id: 'debug', label: 'Debug', createWired: true, liveSwitch: 'designed' },
] as const;

export type ComposerOverflowId =
  | 'attach'
  | 'mention'
  | 'slash'
  | 'mic'
  | 'camera'
  | 'mode';

export interface ComposerOverflowItem {
  id: ComposerOverflowId;
  label: string;
  /** How far this is wired on the phone → Hub path. */
  status: 'wired' | 'partial' | 'designed';
  hint?: string;
}

/** Overflow sheet rows — keep composer bar to + / field / send only. */
export function composerOverflowItems(opts?: {
  attachAvailable?: boolean;
}): ComposerOverflowItem[] {
  const attachOk = opts?.attachAvailable !== false;
  return [
    {
      id: 'attach',
      label: 'Attach file',
      status: attachOk ? 'wired' : 'designed',
      hint: attachOk
        ? 'From PC workspace roots'
        : 'Workspace file list not available',
    },
    {
      id: 'mention',
      label: '@ mention',
      status: 'partial',
      hint: 'Inserts @ — Hub @ picker designed',
    },
    {
      id: 'slash',
      label: '/ command',
      status: 'partial',
      hint: 'Inserts / — slash menu designed',
    },
    {
      id: 'mic',
      label: 'Voice',
      status: 'designed',
      hint: 'Not wired — no mic → Hub path yet',
    },
    {
      id: 'camera',
      label: 'Camera',
      status: 'designed',
      hint: 'Not wired — use Attach for workspace images',
    },
    {
      id: 'mode',
      label: 'Agent mode',
      status: 'partial',
      hint: 'Applied on New chat; live switch designed',
    },
  ];
}

export function defaultAgentMode(): AgentModeId {
  return 'agent';
}

export function isAgentModeId(raw: string | null | undefined): raw is AgentModeId {
  return (
    raw === 'agent' ||
    raw === 'ask' ||
    raw === 'parallel' ||
    raw === 'multitask' ||
    raw === 'debug'
  );
}

export function agentModeLabel(id: AgentModeId): string {
  const hit = AGENT_MODE_OPTIONS.find((m) => m.id === id);
  return hit?.label ?? id;
}
