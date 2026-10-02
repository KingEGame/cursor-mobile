import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { HubClient } from '../hub/client';
import { HubApiError, type WorkspaceBound, type WorkspaceFileItem } from '../hub/types';
import {
  attachmentPathForItem,
  debounce,
  FILE_SEARCH_DEBOUNCE_MS,
  formatPickerRowLabel,
  pathBreadcrumbs,
  rootDisplayName,
  rootQueryForHub,
  toggleAttachment,
} from '../picker/helpers';
import { colors, spacing } from '../theme';

export interface FilePickerSheetProps {
  visible: boolean;
  workspace: WorkspaceBound;
  selected: string[];
  onChangeSelected: (paths: string[]) => void;
  onClose: () => void;
  client: HubClient;
}

/**
 * Phase 3 richer file picker: debounced `q=`, multi-root chips, path breadcrumbs.
 * Paths stay under Hub-reported workspace roots (PC-open project only).
 */
export function FilePickerSheet({
  visible,
  workspace,
  selected,
  onChangeSelected,
  onClose,
  client,
}: FilePickerSheetProps) {
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [browseDir, setBrowseDir] = useState('');
  const [rootIndex, setRootIndex] = useState<number | null>(null);
  const [items, setItems] = useState<WorkspaceFileItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesStub, setFilesStub] = useState(false);
  const requestId = useRef(0);

  const roots = workspace.roots?.length
    ? workspace.roots
    : [{ name: workspace.name, path: workspace.path }];
  const multiRoot = roots.length > 1;
  const activeRoot = rootIndex != null ? roots[rootIndex] ?? null : null;

  const breadcrumbs = useMemo(
    () =>
      pathBreadcrumbs(
        browseDir,
        activeRoot ? rootDisplayName(activeRoot) : workspace.name,
      ),
    [browseDir, activeRoot, workspace.name],
  );

  const setDebounced = useMemo(
    () =>
      debounce((next: string) => {
        setDebouncedQ(next);
      }, FILE_SEARCH_DEBOUNCE_MS),
    [],
  );

  useEffect(() => () => setDebounced.cancel(), [setDebounced]);

  const loadFiles = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const rootFilter = rootQueryForHub(activeRoot, workspace.path);
      const browseFilter =
        !debouncedQ.trim() && browseDir
          ? rootFilter
            ? `${rootFilter}/${browseDir}`
            : browseDir
          : rootFilter;

      const res = await client.getWorkspaceFiles({
        q: debouncedQ.trim() || undefined,
        root: browseFilter,
        limit: 80,
      });
      if (id !== requestId.current) return;

      let next = res.items;
      // When browsing a directory without search, prefer immediate children.
      if (!debouncedQ.trim() && browseDir) {
        const prefix = browseDir.endsWith('/') ? browseDir : `${browseDir}/`;
        const depth = browseDir.split('/').filter(Boolean).length + 1;
        next = res.items.filter((item) => {
          if (!item.path.startsWith(prefix) && item.path !== browseDir) return false;
          if (item.path === browseDir) return false;
          const parts = item.path.split('/').filter(Boolean);
          return parts.length === depth;
        });
        if (next.length === 0) {
          next = res.items.filter(
            (item) => item.path.startsWith(prefix) || item.path === browseDir,
          );
        }
      } else if (!debouncedQ.trim() && !browseFilter) {
        // Top level: show shallow entries first.
        const shallow = res.items.filter(
          (item) => item.path.split('/').filter(Boolean).length === 1,
        );
        if (shallow.length > 0) next = shallow;
      }

      setItems(next);
      setFilesStub(false);
    } catch (err) {
      if (id !== requestId.current) return;
      if (err instanceof HubApiError && err.isRouteMissing) {
        setFilesStub(true);
        setItems([]);
      } else if (err instanceof HubApiError) {
        setError(`${err.code}: ${err.message}`);
        setItems([]);
      } else {
        setError(err instanceof Error ? err.message : 'File search failed');
        setItems([]);
      }
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, [activeRoot, browseDir, client, debouncedQ, workspace.path]);

  useEffect(() => {
    if (!visible) return;
    void loadFiles();
  }, [visible, loadFiles]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setDebouncedQ('');
      setBrowseDir('');
      setRootIndex(null);
      setError(null);
      setDebounced.cancel();
    }
  }, [visible, setDebounced]);

  const onQueryChange = (text: string) => {
    setQuery(text);
    setDebounced(text);
  };

  const onToggle = (path: string) => {
    onChangeSelected(toggleAttachment(selected, path));
  };

  const onDirPress = (item: WorkspaceFileItem) => {
    if (item.kind !== 'dir') return;
    setBrowseDir(item.path);
    setQuery('');
    setDebouncedQ('');
    setDebounced.cancel();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modal} testID="file-picker-sheet">
        <Text style={styles.title}>Workspace files</Text>
        <Text style={styles.hint}>
          Search and attach paths under the PC-open project roots. Tools stay on the PC.
        </Text>

        {multiRoot ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rootChips}
          >
            <Pressable
              style={[styles.rootChip, rootIndex === null && styles.rootChipActive]}
              onPress={() => {
                setRootIndex(null);
                setBrowseDir('');
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: rootIndex === null }}
            >
              <Text
                style={
                  rootIndex === null ? styles.rootChipTextActive : styles.rootChipText
                }
              >
                All roots
              </Text>
            </Pressable>
            {roots.map((r, i) => (
              <Pressable
                key={`${r.path}-${i}`}
                style={[styles.rootChip, rootIndex === i && styles.rootChipActive]}
                onPress={() => {
                  setRootIndex(i);
                  setBrowseDir('');
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: rootIndex === i }}
              >
                <Text
                  style={
                    rootIndex === i ? styles.rootChipTextActive : styles.rootChipText
                  }
                >
                  {rootDisplayName(r)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.crumbs}
        >
          {breadcrumbs.map((crumb, i) => {
            const last = i === breadcrumbs.length - 1;
            return (
              <View key={`${crumb.path}-${i}`} style={styles.crumbRow}>
                {i > 0 ? <Text style={styles.crumbSep}> / </Text> : null}
                <Pressable
                  disabled={last && !debouncedQ}
                  onPress={() => {
                    setBrowseDir(crumb.path);
                    setQuery('');
                    setDebouncedQ('');
                    setDebounced.cancel();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Breadcrumb ${crumb.label}`}
                >
                  <Text style={last ? styles.crumbActive : styles.crumbLink}>
                    {crumb.label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>

        {filesStub ? (
          <Text style={styles.warn}>
            GET /workspace/files not on Hub yet — type a relative path and tap Add stub path.
          </Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TextInput
          style={styles.search}
          value={query}
          onChangeText={onQueryChange}
          placeholder="Search paths (debounced q=)"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search workspace files"
          testID="file-picker-search"
        />

        {busy ? <ActivityIndicator color={colors.accent} /> : null}

        {filesStub ? (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              const path = query.trim();
              if (path) {
                onToggle(path);
                onClose();
              }
            }}
          >
            <Text style={styles.secondaryButtonText}>Add stub path</Text>
          </Pressable>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(i) => `${i.rootPath}:${i.path}`}
            style={styles.list}
            renderItem={({ item }) => {
              const isFile = item.kind === 'file';
              const attachPath = isFile
                ? attachmentPathForItem(item, roots, workspace.path)
                : item.path;
              const isSelected = isFile && selected.includes(attachPath);
              const labels = formatPickerRowLabel(item, roots);
              return (
                <Pressable
                  style={[styles.fileRow, isSelected && styles.fileRowSelected]}
                  onPress={() => {
                    if (item.kind === 'dir') onDirPress(item);
                    else onToggle(attachPath);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  testID={
                    isFile
                      ? `file-picker-file-${item.path.replace(/[^a-zA-Z0-9._-]+/g, '_')}`
                      : `file-picker-dir-${item.path.replace(/[^a-zA-Z0-9._-]+/g, '_')}`
                  }
                >
                  <View style={styles.fileMain}>
                    <Text style={styles.filePath}>
                      {item.kind === 'dir' ? '[dir] ' : ''}
                      {labels.title}
                    </Text>
                    {labels.subtitle ? (
                      <Text style={styles.meta}>{labels.subtitle}</Text>
                    ) : null}
                    {item.kind === 'file' && item.sizeBytes != null ? (
                      <Text style={styles.meta}>{item.sizeBytes} B</Text>
                    ) : null}
                  </View>
                  <Text style={styles.meta}>
                    {item.kind === 'dir' ? 'Open' : isSelected ? 'Selected' : 'Tap'}
                  </Text>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.body}>
                {busy ? 'Searching…' : 'No files matched under this root.'}
              </Text>
            }
          />
        )}

        <Pressable
          style={styles.button}
          onPress={onClose}
          accessibilityRole="button"
          testID="file-picker-done"
        >
          <Text style={styles.buttonText}>Done ({selected.length})</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    paddingTop: spacing.xl,
    gap: spacing.sm,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  warn: { color: colors.warn, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
  rootChips: { gap: spacing.sm, paddingVertical: spacing.xs },
  rootChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    marginRight: spacing.sm,
  },
  rootChipActive: { borderColor: colors.accent, backgroundColor: '#1a2e24' },
  rootChipText: { color: colors.text, fontSize: 13 },
  rootChipTextActive: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  crumbs: { alignItems: 'center', paddingVertical: spacing.xs },
  crumbRow: { flexDirection: 'row', alignItems: 'center' },
  crumbSep: { color: colors.muted, fontSize: 12 },
  crumbLink: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  crumbActive: { color: colors.text, fontSize: 13, fontWeight: '700' },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    color: colors.text,
  },
  list: { flex: 1 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fileRowSelected: { backgroundColor: '#1a2e24' },
  fileMain: { flex: 1, gap: 2 },
  filePath: { color: colors.text, fontFamily: 'monospace', fontSize: 13 },
  meta: { color: colors.muted, fontSize: 12 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
  secondaryButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  secondaryButtonText: { color: colors.text, fontWeight: '600' },
});
