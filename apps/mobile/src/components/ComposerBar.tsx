import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AGENT_MODE_OPTIONS,
  agentModeLabel,
  composerOverflowItems,
  type AgentModeId,
  type ComposerOverflowId,
} from '../hub/composer-chrome';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';

export interface ComposerBarProps {
  inputRef?: React.RefObject<TextInput | null>;
  defaultValue?: string;
  placeholder: string;
  editable: boolean;
  sendBusy: boolean;
  sendDisabled: boolean;
  agentMode: AgentModeId;
  onChangeText: (text: string) => void;
  onEndEditing?: (text: string) => void;
  onSend: () => void;
  onAgentModeChange: (mode: AgentModeId) => void;
  onOverflowAction: (id: ComposerOverflowId) => void;
  attachAvailable?: boolean;
  testID?: string;
}

/**
 * Gemini-like composer: [+] | text field | Send.
 * Extra actions live in one overflow sheet — no icon toolbar.
 */
export function ComposerBar({
  inputRef,
  defaultValue,
  placeholder,
  editable,
  sendBusy,
  sendDisabled,
  agentMode,
  onChangeText,
  onEndEditing,
  onSend,
  onAgentModeChange,
  onOverflowAction,
  attachAvailable = true,
  testID,
}: ComposerBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [modePicker, setModePicker] = useState(false);
  const items = useMemo(
    () => composerOverflowItems({ attachAvailable }),
    [attachAvailable],
  );

  const runOverflow = (id: ComposerOverflowId) => {
    if (id === 'mode') {
      setModePicker(true);
      return;
    }
    setSheetOpen(false);
    onOverflowAction(id);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Pressable
          style={styles.plus}
          onPress={() => setSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="More composer actions"
          testID="composer-plus"
          collapsable={false}
        >
          <Text style={styles.plusText}>+</Text>
        </Pressable>
        <TextInput
          ref={inputRef}
          style={styles.input}
          defaultValue={defaultValue}
          onChangeText={onChangeText}
          onEndEditing={(e) => onEndEditing?.(e.nativeEvent.text ?? '')}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          editable={editable}
          multiline
          accessibilityLabel="Message input"
          testID={testID ?? 'live-chat-composer'}
        />
        <Pressable
          style={[styles.send, sendDisabled && styles.sendDisabled]}
          onPress={onSend}
          disabled={sendDisabled}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          testID="live-chat-send"
          collapsable={false}
        >
          {sendBusy ? (
            <ActivityIndicator color={colors.accentText} />
          ) : (
            <Text style={styles.sendText} importantForAccessibility="no">
              Send
            </Text>
          )}
        </Pressable>
      </View>
      <Text style={styles.modeHint} testID="composer-mode-hint">
        {agentModeLabel(agentMode)}
        {AGENT_MODE_OPTIONS.find((m) => m.id === agentMode)?.liveSwitch === 'designed'
          ? ' · live switch designed'
          : ''}
      </Text>

      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setSheetOpen(false)} />
        <View style={styles.sheet} testID="composer-overflow-sheet">
          <Text style={styles.sheetTitle}>Add</Text>
          {items.map((item) => (
            <Pressable
              key={item.id}
              style={styles.sheetRow}
              onPress={() => runOverflow(item.id)}
              accessibilityRole="button"
              testID={`composer-overflow-${item.id}`}
            >
              <View style={styles.sheetRowText}>
                <Text style={styles.sheetLabel}>{item.label}</Text>
                {item.hint ? <Text style={styles.sheetHint}>{item.hint}</Text> : null}
              </View>
              <Text style={styles.sheetStatus}>{item.status}</Text>
            </Pressable>
          ))}
          <Pressable
            style={styles.sheetCancel}
            onPress={() => setSheetOpen(false)}
            accessibilityRole="button"
          >
            <Text style={styles.sheetCancelText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      <Modal
        visible={modePicker}
        transparent
        animationType="fade"
        onRequestClose={() => setModePicker(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setModePicker(false)} />
        <View style={styles.modeSheet} testID="composer-mode-sheet">
          <Text style={styles.sheetTitle}>Agent mode</Text>
          <Text style={styles.sheetHint}>
            Sent with New chat create. Live mid-chat switch is designed (not VERIFIED CDP).
          </Text>
          {AGENT_MODE_OPTIONS.map((m) => (
            <Pressable
              key={m.id}
              style={[styles.sheetRow, agentMode === m.id && styles.sheetRowActive]}
              onPress={() => {
                onAgentModeChange(m.id);
                setModePicker(false);
                setSheetOpen(false);
              }}
              accessibilityRole="button"
              testID={`composer-mode-${m.id}`}
            >
              <Text style={styles.sheetLabel}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingBottom: spacing.sm,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  plus: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: {
    color: colors.text,
    fontSize: type.title,
    fontWeight: weight.regular,
    marginTop: -2,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: type.body,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minWidth: 64,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { backgroundColor: colors.border },
  sendText: { color: colors.accentText, fontWeight: weight.semibold },
  modeHint: {
    color: colors.muted,
    fontSize: type.meta,
    paddingHorizontal: spacing.md,
    paddingTop: 4,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  modeSheet: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: weight.semibold,
    marginBottom: spacing.sm,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  sheetRowActive: {
    backgroundColor: colors.accentSoft,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderBottomWidth: 0,
  },
  sheetRowText: { flex: 1, gap: spacing.xxs },
  sheetLabel: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  sheetHint: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta },
  sheetStatus: {
    color: colors.muted,
    fontSize: type.meta,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  sheetCancel: {
    marginTop: spacing.md,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  sheetCancelText: { color: colors.accent, fontWeight: weight.semibold, fontSize: type.body },
});
