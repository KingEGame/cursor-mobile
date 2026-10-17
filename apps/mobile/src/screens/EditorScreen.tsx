import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { createHubClient } from '../hub/client';
import {
  HubApiError,
  isWorkspaceBound,
  type WorkspaceFileItem,
  type WorkspaceFilePreview,
} from '../hub/types';
import type { RootStackParamList } from '../navigation/types';
import {
  debounce,
  FILE_SEARCH_DEBOUNCE_MS,
  formatPickerRowLabel,
  pathBreadcrumbs,
  rootDisplayName,
} from '../picker/helpers';
import { useAppSession } from '../session/AppSessionContext';
import { colors, spacing, type, weight, lineHeight } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Editor'>;

/**
 * Optional Phase 3 Editor (FR-070 / FR-071): browse + read-only preview via Hub.
 * Not a code-server IDE — project open remains on the PC.
 */
export function EditorScreen({ navigation }: Props) {
  const session = useAppSession();
  // Stable callbacks only — depending on `session` itself re-creates loaders on every
  // setHealthAndWorkspace and causes an endless refresh / WS reconnect loop.
    const workspace = session.workspace;
  const boundWs = workspace && isWorkspaceBound(workspace) ? workspace : null;

  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<WorkspaceFileItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const requestId = useRef(0);

  const roots = boundWs?.roots?.length
    ? boundWs.roots
    : boundWs
      ? [{ name: boundWs.name, path: boundWs.path }]
      : [];

  const setDebounced = useMemo(
    () =>
      debounce((next: string) => {
        setDebouncedQ(next);
      }, FILE_SEARCH_DEBOUNCE_MS),
    [],
  );

  useEffect(() => () => setDebounced.cancel(), [setDebounced]);

  const client = useCallback(() => {
    if (!session.hubBaseUrl || !session.deviceToken) {
      throw new HubApiError(401, 'NOT_PAIRED', 'Not paired');
    }
    return createHubClient({
      baseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
    });
  }, [session.hubBaseUrl, session.deviceToken]);

  const loadList = useCallback(async () => {
    if (!boundWs) return;
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const res = await client().getWorkspaceFiles({
        q: debouncedQ.trim() || undefined,
        limit: 60,
      });
      if (id !== requestId.current) return;
      setItems(res.items.filter((i) => i.kind === 'file'));
    } catch (err) {
      if (id !== requestId.current) return;
      if (err instanceof HubApiError && err.status === 401) {
        // Keep the token: a 401 can come from a Hub restarted with another data dir.
        // Pair overwrites it on success; Account → Clear pairing still wipes it.
        navigation.replace('Pair');
        return;
      }
      if (err instanceof HubApiError) {
        setError(`${err.code}: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : 'List failed');
      }
      setItems([]);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, [boundWs, client, debouncedQ, navigation]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openPreview = async (path: string) => {
    setSelectedPath(path);
    setPreview(null);
    setPreviewNote(null);
    setBusy(true);
    try {
      const res = await client().getWorkspaceFile(path);
      setPreview(res);
      setPreviewNote(res.note ?? null);
    } catch (err) {
      if (err instanceof HubApiError && err.isRouteMissing) {
        setPreviewNote(
          'GET /workspace/file not on Hub yet — list-only editor. Open the file on the PC in Cursor.',
        );
      } else if (err instanceof HubApiError) {
        setPreviewNote(`${err.code}: ${err.message}`);
      } else {
        setPreviewNote(err instanceof Error ? err.message : 'Preview failed');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!boundWs) {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Editor (optional)</Text>
        <Text style={styles.body}>
          Open a project in Cursor on the PC first. This screen only browses the bound workspace —
          it does not open arbitrary folders from the phone.
        </Text>
        <Pressable style={styles.button} onPress={() => navigation.goBack()}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const crumbs = pathBreadcrumbs(selectedPath ?? '', boundWs.name);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Editor (optional)</Text>
        <Text style={styles.hint}>
          Phase 3 browse / attach preview — not a full IDE. Edit and tools stay on the PC.
        </Text>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setDebounced(t);
          }}
          placeholder="Search files (debounced q=)"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search editor files"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <View style={styles.split}>
        <FlatList
          style={styles.listPane}
          data={items}
          keyExtractor={(i) => i.path}
          ListHeaderComponent={
            busy && items.length === 0 ? (
              <ActivityIndicator color={colors.accent} />
            ) : null
          }
          renderItem={({ item }) => {
            const labels = formatPickerRowLabel(item, roots);
            const active = item.path === selectedPath;
            return (
              <Pressable
                style={[styles.fileRow, active && styles.fileRowActive]}
                onPress={() => void openPreview(item.path)}
                accessibilityRole="button"
              >
                <Text style={styles.filePath} numberOfLines={2}>
                  {labels.title}
                </Text>
                {labels.subtitle ? (
                  <Text style={styles.meta}>{labels.subtitle}</Text>
                ) : null}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.body}>{busy ? 'Loading…' : 'No files matched.'}</Text>
          }
        />

        <ScrollView style={styles.previewPane} contentContainerStyle={styles.previewContent}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={styles.crumbs}>
              {crumbs.map((c) => c.label).join(' / ')}
            </Text>
          </ScrollView>
          {previewNote ? <Text style={styles.warn}>{previewNote}</Text> : null}
          {preview?.binary ? (
            <Text style={styles.body}>Binary file — open on PC.</Text>
          ) : preview ? (
            <>
              <Text style={styles.meta}>
                {rootDisplayName({ name: boundWs.name, path: boundWs.path })} ·{' '}
                {preview.sizeBytes} B
                {preview.truncated ? ' · truncated' : ''}
              </Text>
              <Text style={styles.previewText} selectable>
                {preview.content || '(empty)'}
              </Text>
            </>
          ) : (
            <Text style={styles.body}>
              Tap a file for read-only Hub preview. WebView / code-server is not required for v1 —
              this list+preview path is the optional Phase 3 editor.
            </Text>
          )}
          {selectedPath ? (
            <Pressable
              style={styles.secondaryButton}
              onPress={() =>
                navigation.navigate('NewSession')
              }
              accessibilityRole="button"
            >
              <Text style={styles.secondaryButtonText}>
                Attach via New session ({selectedPath})
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: spacing.md, gap: spacing.sm },
  header: { gap: spacing.sm },
  title: { color: colors.text, fontSize: type.sub, fontWeight: weight.semibold },
  hint: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta },
  body: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.body },
  warn: { color: colors.warn, fontSize: type.meta, lineHeight: lineHeight.meta },
  error: { color: colors.danger, fontSize: type.meta },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    color: colors.text,
  },
  split: { flex: 1, flexDirection: 'row', gap: spacing.sm },
  listPane: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  previewPane: {
    flex: 1.2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  previewContent: { padding: spacing.md, gap: spacing.sm },
  fileRow: {
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fileRowActive: { backgroundColor: colors.accentSoft },
  filePath: { color: colors.text, fontFamily: 'monospace', fontSize: type.meta },
  meta: { color: colors.muted, fontSize: type.meta },
  crumbs: { color: colors.accent, fontSize: type.meta, fontWeight: weight.semibold },
  previewText: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: type.meta,
    lineHeight: lineHeight.meta,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonText: { color: colors.accentText, fontWeight: weight.semibold, fontSize: type.body },
  secondaryButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
  secondaryButtonText: { color: colors.text, fontWeight: weight.semibold, fontSize: type.meta, textAlign: 'center' },
});
