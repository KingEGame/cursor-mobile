import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { HealthDotLevel } from '../components/HealthDot';
import type { HealthResponse, WorkspaceResponse } from '../hub/types';

export type { HealthDotLevel };

export type RootStackParamList = {
  /** Optional deep-link / QR fields — `cursor-companion://pair?host=&port=&code=&pairId=` */
  Pair:
    | undefined
    | {
        code?: string;
        pairId?: string;
        host?: string;
        port?: string;
        hubUrl?: string;
        /** When true (default if code present), auto-submit pairComplete */
        auto?: string;
        /** UAT/ops: inject already-completed pair token (PC did pairComplete). */
        deviceToken?: string;
        deviceId?: string;
        hubDisplayName?: string;
        /** QR identity (Hub ≥ 0.1.8): PC name and stable hub id. */
        name?: string;
        hub?: string;
      };
  Health: undefined;
  /**
   * Main shell — bottom tabs Chats | Account (Gemini-style).
   * Deep link `home` / `nav/home` lands here.
   */
  Main: undefined;
  /** @deprecated Alias for Main — kept for older deep links / UAT scripts. */
  Home: undefined;
  LiveChat: { sessionId: string; title?: string; prefill?: string; autosend?: boolean };
  HistoryRead: { sessionId: string; title?: string };
  /** Start a new Agents chat in a PC project (Home → New Chat). */
  NewAgentChat: { projectId?: string } | undefined;
  /** Files an Agents chat changed; `index` set → that file's diff. */
  ChatChanges: { composerId: string; title?: string; index?: number; path?: string };
  /**
   * Optional deep-link inject — `cursor-companion://new?prompt=&model=&attach=&auto=`
   * Adb UAT must set prompt/model/attach in React state (RN TextInput ignores adb).
   */
  NewSession:
    | undefined
    | {
        prompt?: string;
        model?: string;
        /** One path or list (from repeated `attach=` query params). */
        attach?: string | string[];
        /** `1` → auto Create after models/workspace ready. */
        auto?: string;
      };
  /** Optional Phase 3 browse/preview (FR-070) */
  Editor: undefined;
  /** Self-update from the PC Hub (Account → See what's new). */
  Update: undefined;
};

export type RootNav = NativeStackNavigationProp<RootStackParamList>;

export interface AppSession {
  hubBaseUrl: string;
  deviceToken: string | null;
  deviceId: string | null;
  hubDisplayName: string | null;
  /** Stable id of the active PC's Hub (Hub ≥ 0.1.8). */
  hubId: string | null;
  health: HealthResponse | null;
  workspace: WorkspaceResponse | null;
  healthLevel: HealthDotLevel;
  bootstrapped: boolean;
}

export function deriveHealthLevel(health: HealthResponse | null): HealthDotLevel {
  if (!health) return 'unknown';
  if (!health.ok) return 'down';
  if (health.cdp.status !== 'connected') return 'degraded';
  if (!health.workspace?.bound) return 'degraded';
  return 'healthy';
}
