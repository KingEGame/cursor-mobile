import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { createHubClient } from '../hub/client';
import { HubApiError, type ChatFileChange, type ChatFileDiff } from '../hub/types';
import type { RootStackParamList } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ChatChanges'>;

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Last two path segments — enough to recognise a file on a phone. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * Read-only view of what an Agents chat changed on the PC.
 * Without `index`: list of files. With `index`: that file's diff.
 */
export function ChatChangesScreen({ navigation, route }: Props) {
  const session = useAppSession();
  const { composerId, title, index } = route.params;
  const [files, setFiles] = useState<ChatFileChange[] | null>(null);
  const [diff, setDiff] = useState<ChatFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = useMemo(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return null;
    return createHubClient({ baseUrl: session.hubBaseUrl, deviceToken: session.deviceToken });
  }, [session.hubBaseUrl, session.deviceToken]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const load =
      index === undefined
        ? client.listChatChanges(composerId).then((r) => !cancelled && setFiles(r.files))
        : client.getChatFileDiff(composerId, index).then((d) => !cancelled && setDiff(d));
    load.catch((err) => {
      if (!cancelled) setError(err instanceof HubApiError ? err.message : 'Could not load changes');
    });
    return () => {
      cancelled = true;
    };
  }, [client, composerId, index]);

  if (error) return <Text style={styles.error}>{error}</Text>;

  if (index === undefined) {
    if (!files) return <ActivityIndicator color={colors.accent} style={styles.spinner} />;
    return (
      <FlatList
        style={styles.root}
        data={files}
        keyExtractor={(f) => String(f.index)}
        ListHeaderComponent={
          <View style={styles.header}>
            {title ? <Text style={styles.title}>{title}</Text> : null}
            <Text style={styles.note}>
              Read-only. Compared with each file as it is on the PC now, since this chat first
              edited it.
            </Text>
          </View>
        }
        ListEmptyComponent={<Text style={styles.note}>This chat has not changed any files.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
            onPress={() =>
              navigation.push('ChatChanges', { composerId, index: item.index, path: item.path })
            }
            accessibilityRole="button"
            accessibilityLabel={`${shortPath(item.path)}, ${item.added} added, ${item.removed} removed`}
          >
            <View style={styles.fileBody}>
              <Text style={styles.fileName} numberOfLines={1}>
                {shortPath(item.path)}
              </Text>
              <Text style={styles.filePath} numberOfLines={1}>
                {item.path}
              </Text>
            </View>
            <Text style={styles.counts}>
              {item.skipped ? (
                <Text style={styles.muted}>{item.skipped}</Text>
              ) : (
                <>
                  <Text style={styles.plus}>+{item.added}</Text>{' '}
                  <Text style={styles.minus}>−{item.removed}</Text>
                </>
              )}
            </Text>
            {item.isNew || item.deleted ? (
              <Text style={styles.badge}>{item.isNew ? 'new' : 'deleted'}</Text>
            ) : null}
          </Pressable>
        )}
      />
    );
  }

  if (!diff) return <ActivityIndicator color={colors.accent} style={styles.spinner} />;
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.diffContent}>
      <Text style={styles.title}>{shortPath(diff.path)}</Text>
      <Text style={styles.filePath}>{diff.path}</Text>
      <Text style={styles.counts}>
        <Text style={styles.plus}>+{diff.added}</Text> <Text style={styles.minus}>−{diff.removed}</Text>
      </Text>
      {diff.skipped ? <Text style={styles.note}>{diff.skipped}</Text> : null}
      {diff.hunks.map((h, i) => (
        <View key={i} style={styles.hunk}>
          <Text style={styles.hunkHead}>
            @@ line {h.oldStart} → {h.newStart}
          </Text>
          {/* Long code lines scroll sideways instead of wrapping into unreadable stacks. */}
          <ScrollView horizontal>
            <View>
              {h.lines.map((line, j) => (
                <Text
                  key={j}
                  style={[
                    styles.line,
                    line.startsWith('+') && styles.lineAdd,
                    line.startsWith('-') && styles.lineDel,
                  ]}
                  selectable
                >
                  {line || ' '}
                </Text>
              ))}
            </View>
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  spinner: { marginTop: spacing.xl },
  error: { color: colors.danger, padding: spacing.md },
  header: { padding: spacing.md, gap: spacing.xs },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.md },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: { backgroundColor: colors.surfaceMuted },
  fileBody: { flex: 1, minWidth: 0 },
  fileName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  filePath: { color: colors.muted, fontSize: 11 },
  counts: { fontSize: 13, fontFamily: MONO },
  plus: { color: colors.accent },
  minus: { color: colors.danger },
  muted: { color: colors.muted },
  badge: { color: colors.warn, fontSize: 11, fontWeight: '700' },
  diffContent: { padding: spacing.md, gap: spacing.sm },
  hunk: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  hunkHead: {
    fontFamily: MONO,
    fontSize: 11,
    color: colors.muted,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  line: { fontFamily: MONO, fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.sm, color: colors.text },
  lineAdd: { backgroundColor: '#e6f4ea', color: '#0d5d2c' },
  lineDel: { backgroundColor: '#fce8e6', color: '#8c1d18' },
});
