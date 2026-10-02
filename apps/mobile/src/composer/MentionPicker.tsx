import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FileText, Plug, Slash, X } from 'lucide-react-native';
import type { HubClient } from '../hub/client';
import { isPluginOption, usableOption } from '../hub/composer';
import type { MentionOption, MentionRef } from '../hub/types';
import { colors, radii, spacing } from '../theme';

export type PickerKind = 'files' | 'skills' | 'plugins';

const KIND: Record<PickerKind, { title: string; trigger: '@' | '/'; hint: string; needsQuery: boolean }> = {
  files: { title: 'Add files', trigger: '@', hint: 'Type part of a file name in this project', needsQuery: true },
  skills: { title: 'Skills & rules', trigger: '/', hint: 'Search skills, commands and rules', needsQuery: false },
  plugins: { title: 'Plugins (MCP)', trigger: '@', hint: 'MCP servers set up in Cursor on your PC', needsQuery: false },
};

/**
 * Lists what Cursor on the PC offers after "@" or "/" for this chat (files are
 * project-scoped) and returns the picked item as a chip reference.
 */
export function MentionPicker(props: {
  visible: boolean;
  kind: PickerKind;
  client: HubClient | null;
  composerId: string;
  onPick: (ref: MentionRef) => void;
  onClose: () => void;
}) {
  const { visible, kind, client, composerId, onPick, onClose } = props;
  const cfg = KIND[kind];
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<MentionOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setOptions(null);
      setError(null);
    }
  }, [visible]);

  // Each lookup briefly types into the PC composer, so debounce generously.
  useEffect(() => {
    if (!visible || !client) return;
    if (cfg.needsQuery && query.trim().length === 0) {
      setOptions([]);
      return;
    }
    const id = ++seq.current;
    setOptions(null);
    const t = setTimeout(() => {
      client
        .listChatMentions(composerId, cfg.trigger, kind === 'plugins' && !query.trim() ? '' : query.trim())
        .then((res) => {
          if (id !== seq.current) return;
          const list = res.options.filter((o) =>
            kind === 'plugins' ? isPluginOption(o) && usableOption(o) : kind === 'files' ? !isPluginOption(o) : true,
          );
          setOptions(list);
          setError(null);
        })
        .catch(() => {
          if (id === seq.current) setError('Could not read the list from Cursor on the PC');
        });
    }, 600);
    return () => clearTimeout(t);
  }, [visible, client, composerId, query, kind, cfg.trigger, cfg.needsQuery]);

  const Icon = kind === 'files' ? FileText : kind === 'skills' ? Slash : Plug;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{cfg.title}</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <X size={22} color={colors.muted} />
            </Pressable>
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={cfg.hint}
            placeholderTextColor={colors.muted}
            style={styles.search}
            autoFocus={cfg.needsQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {options === null ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
          ) : (
            <FlatList
              data={options}
              keyExtractor={(o, i) => `${o.label}|${o.detail}|${i}`}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={styles.empty}>
                  {cfg.needsQuery && !query.trim() ? cfg.hint : 'Nothing matches on the PC'}
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  onPress={() => {
                    onPick({
                      trigger: cfg.trigger,
                      label: item.label,
                      ...(kind === 'files' && item.detail ? { detail: item.detail } : {}),
                    });
                    onClose();
                  }}
                >
                  <Icon size={18} color={colors.muted} strokeWidth={1.75} />
                  <View style={styles.rowBody}>
                    <Text style={styles.label} numberOfLines={1}>
                      {item.label}
                    </Text>
                    {item.detail ? (
                      <Text style={styles.detail} numberOfLines={1}>
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                  {kind === 'plugins' && item.hint ? <Text style={styles.hint}>{item.hint}</Text> : null}
                </Pressable>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.md,
    maxHeight: '80%',
    minHeight: '50%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  search: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    color: colors.text,
    fontSize: 16,
    marginBottom: spacing.sm,
  },
  error: { color: colors.danger, marginBottom: spacing.sm },
  empty: { color: colors.muted, textAlign: 'center', marginTop: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingHorizontal: spacing.xs },
  pressed: { backgroundColor: colors.surfaceMuted },
  rowBody: { flex: 1, minWidth: 0 },
  label: { color: colors.text, fontSize: 15 },
  detail: { color: colors.muted, fontSize: 12 },
  hint: { color: colors.accent, fontSize: 12 },
});
