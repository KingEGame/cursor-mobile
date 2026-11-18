/**
 * Mate presence mirror: always-on status screen for the Pixel 7.
 *
 * Dark theme, keepAwake when charging, large state indicator, current block + remaining,
 * last kick/brief, approve/deny buttons for pending approval.
 *
 * The phone is only a mirror — no decisions except approve/deny (sent as a regular
 * message with clientMessageId).
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake, useKeepAwake } from 'expo-keep-awake';
import { useBridge } from '../bridge/BridgeProvider';
import type { KickEvent, BriefEvent } from '../bridge/types';
import { colors as lightColors } from '../theme';
import { newClientMessageId } from '../bridge/client';

// ── dark palette for the always-on Mate screen ────────────────────────────────
const c = {
  bg: '#121212',
  surface: '#1e1e1e',
  surfaceMuted: '#2a2a2a',
  text: '#e1e3e6',
  muted: '#9aa0a6',
  border: '#333333',
  borderStrong: '#555555',
  onDark: '#ffffff',
  accent: '#1e6b4a',
  accentDim: '#155535',
  accentText: '#ffffff',
  danger: '#cf6679',
  dangerDim: '#5f2129',
  warn: '#f5b342',
  warnDim: '#5f4000',
};

type MateState = 'on_task' | 'off_task' | 'waiting_approval' | 'idle' | 'unknown';

interface StateConfig {
  label: string;
  color: string;
}

const STATE_CFG: Record<string, StateConfig> = {
  on_task: { label: 'On task', color: '#4caf50' },
  off_task: { label: 'Off task', color: '#ffa726' },
  waiting_approval: { label: 'Needs approval', color: '#42a5f5' },
  idle: { label: 'Idle', color: '#9e9e9e' },
};

function stateLabel(raw: string | null): string {
  return STATE_CFG[raw ?? '']?.label ?? 'Unknown';
}

function stateColor(raw: string | null): string {
  return STATE_CFG[raw ?? '']?.color ?? '#9e9e9e';
}

function ago(ts: string | null | undefined): string {
  if (!ts) return '';
  const t = Date.parse(ts);
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function formatBlockRemaining(name: string | null): string | null {
  if (!name) return null;
  // The block name from Mate is a task id or label — show it as-is for now.
  // Remaining time is not parsed from presence.json (Mate may add it later).
  return name;
}

/** Full-screen dark overlay for the awaiting approval state. */
function ApprovalOverlay({
  visible,
  onApprove,
  onDeny,
  approving,
}: {
  visible: boolean;
  onApprove: () => void;
  onDeny: () => void;
  approving: boolean;
}) {
  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <View style={styles.overlayCard}>
        <View style={[styles.overlayDot, { backgroundColor: '#42a5f5' }]} />
        <Text style={styles.overlayTitle}>Action needs approval</Text>
        <Text style={styles.overlaySub}>
          Mate is waiting for you to approve a DESTRUCTIVE action on the PC.
        </Text>
        <View style={styles.overlayButtons}>
          <Pressable
            style={[styles.overlayBtn, { backgroundColor: c.dangerDim }]}
            onPress={onDeny}
            disabled={approving}
          >
            <Text style={[styles.overlayBtnText, { color: c.danger }]}>
              {approving ? 'Sending…' : 'Deny'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.overlayBtn, { backgroundColor: c.accentDim }]}
            onPress={onApprove}
            disabled={approving}
          >
            <Text style={[styles.overlayBtnText, { color: c.accent }]}>
              {approving ? 'Sending…' : 'Approve'}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function EventCard({ icon, title, text, ts }: { icon: string; title: string; text: string | null | undefined; ts: string | null | undefined }) {
  if (!text && !ts) return null;
  return (
    <View style={styles.eventCard}>
      <Text style={styles.eventIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.eventTitle}>{title}</Text>
        {text ? <Text style={styles.eventText} numberOfLines={2}>{text}</Text> : null}
        {ts ? <Text style={styles.eventTime}>{ago(ts)}</Text> : null}
      </View>
    </View>
  );
}

export function MateScreen() {
  const bridge = useBridge();
  const presence = bridge.mirror.presence;

  // Keep awake while this screen is shown (always-on mode for charging Pixel)
  useKeepAwake();
  useEffect(() => {
    activateKeepAwakeAsync();
    return () => { deactivateKeepAwake(); };
  }, []);
  // Approve/deny state
  const [approving, setApproving] = useState(false);

  // Re-compute "ago" every 30s while visible
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(iv);
  }, []);

  const needsApproval = presence?.state === 'waiting_approval';

  const sendApprove = async (approve: boolean) => {
    if (!bridge.pairing.token) return;
    setApproving(true);
    try {
      const text = approve ? '/approve' : '/deny';
      await bridge.send({}, text);
    } catch {
      // lastError in BridgeProvider will surface
    } finally {
      setApproving(false);
    }
  };

  const color = stateColor(presence?.state ?? null);
  const blockName = presence?.current_block ?? null;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={c.bg} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.body}
      >
        {/* Big state indicator */}
        <View style={styles.indicatorArea}>
          <View style={[styles.indicatorRing, { borderColor: color }]}>
            <View style={[styles.indicatorFill, { backgroundColor: color }]} />
          </View>
          <Text style={styles.stateLabel}>{stateLabel(presence?.state ?? null)}</Text>
          <Text style={styles.pcName}>{bridge.pairing.pcName ?? 'PC'}</Text>
          {presence?.updated_at ? (
            <Text style={styles.updatedAgo}>Updated {ago(presence.updated_at)}</Text>
          ) : null}
        </View>

        {/* Current block */}
        {blockName ? (
          <View style={styles.blockCard}>
            <Text style={styles.blockTitle}>Current block</Text>
            <Text style={styles.blockName}>{blockName}</Text>
          </View>
        ) : null}

        {/* Events */}
        <EventCard
          icon="📍"
          title="Last kick"
          text={presence?.last_kick?.text ?? null}
          ts={presence?.last_kick?.ts ?? null}
        />
        <EventCard
          icon="📋"
          title="Last brief"
          text={presence?.last_brief?.text ?? null}
          ts={presence?.last_brief?.ts ?? null}
        />

        {/* Connection status */}
        <View style={styles.connCard}>
          <Text style={styles.connLabel}>
            {bridge.connection === 'online' ? '🟢 Connected' :
             bridge.connection === 'connecting' ? '🟡 Connecting…' :
             bridge.connection === 'offline' ? '🔴 Offline' :
             bridge.connection === 'revoked' ? '⚫ Revoked' : '⚪ Not paired'}
          </Text>
        </View>

        {/* Bottom padding for overlay */}
        {needsApproval ? <View style={{ height: 200 }} /> : null}
      </ScrollView>

      {/* Approval overlay */}
      <ApprovalOverlay
        visible={needsApproval}
        onApprove={() => void sendApprove(true)}
        onDeny={() => void sendApprove(false)}
        approving={approving}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: c.bg,
  },
  scroll: {
    flex: 1,
  },
  body: {
    padding: 24,
    alignItems: 'center',
  },
  indicatorArea: {
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 32,
  },
  indicatorRing: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  indicatorFill: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  stateLabel: {
    fontSize: 24,
    fontWeight: '600',
    color: c.text,
    marginBottom: 4,
  },
  pcName: {
    fontSize: 14,
    color: c.muted,
    marginBottom: 4,
  },
  updatedAgo: {
    fontSize: 12,
    color: c.muted,
  },
  blockCard: {
    width: '100%',
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  blockTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: c.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  blockName: {
    fontSize: 18,
    fontWeight: '600',
    color: c.text,
  },
  eventCard: {
    width: '100%',
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  eventIcon: {
    fontSize: 20,
    marginRight: 12,
    marginTop: 2,
  },
  eventTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: c.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  eventText: {
    fontSize: 15,
    color: c.text,
    lineHeight: 20,
  },
  eventTime: {
    fontSize: 12,
    color: c.muted,
    marginTop: 4,
  },
  connCard: {
    width: '100%',
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
  },
  connLabel: {
    fontSize: 13,
    color: c.muted,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    padding: 24,
    paddingBottom: 40,
  },
  overlayCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  overlayDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    marginBottom: 12,
  },
  overlayTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: c.text,
    marginBottom: 8,
  },
  overlaySub: {
    fontSize: 14,
    color: c.muted,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  overlayButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  overlayBtn: {
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 12,
  },
  overlayBtnText: {
    fontSize: 16,
    fontWeight: '600',
  },
});