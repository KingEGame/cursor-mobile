import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { FilePickerSheet } from '../components/FilePickerSheet';
import {
  createHubClient,
  isLivePathDegraded,
  livePathDegradedReason,
} from '../hub/client';
import { modelSourceLabel } from '../hub/history-list';
import {
  AGENT_MODE_OPTIONS,
  defaultAgentMode,
  type AgentModeId,
} from '../hub/composer-chrome';
import { unboundWorkspaceCreateGuidance } from '../hub/session-list-ux';
import {
  EMPTY_MODELS_BODY,
  modelsDisappearedMessage,
  pickDefaultModelId,
} from '../hub/new-session-models';
import { shortPath } from '../hub/format';
import {
  HubApiError,
  isQueuedCreateSession,
  isWorkspaceBound,
  type WorkspaceModel,
} from '../hub/types';
import {
  isNewSessionAutoCreate,
  normalizeAttachPaths,
  parseNewSessionDeepLink,
  type NewSessionDeepLinkParams,
} from '../navigation/new-session-deep-link';
import type { RootStackParamList } from '../navigation/types';
import { toggleAttachment } from '../picker/helpers';
import {
  createQueueBannerText,
  createQueueStatusFromHealth,
  drainedSessionIdFromHealth,
} from '../queue/session-create-queue';
import { useAppSession } from '../session/AppSessionContext';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'NewSession'>;

export function NewSessionScreen({ navigation, route }: Props) {
  const session = useAppSession();
  // Stable callbacks only — depending on `session` itself re-creates loaders on every
  // setHealthAndWorkspace and causes an endless refresh / WS reconnect loop.
  const { setHealthAndWorkspace } = session;
  const workspace = session.workspace;
  const boundWs = workspace && isWorkspaceBound(workspace) ? workspace : null;
  const routeParams = route.params;

  const [models, setModels] = useState<WorkspaceModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [agentMode, setAgentMode] = useState<AgentModeId>(defaultAgentMode());
  const [toolsNote, setToolsNote] = useState<string | null>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  /** True after Hub 202 or CDP_UNAVAILABLE — poll until drain. */
  const [awaitingQueue, setAwaitingQueue] = useState(false);
  const [queueBanner, setQueueBanner] = useState<string | null>(null);

  /** Injected model id from deep link — survives loadSheetData default pick. */
  const injectModelRef = useRef<string | null>(null);
  const autoCreateDoneRef = useRef(false);
  const wantAutoCreateRef = useRef(false);

  const degraded = isLivePathDegraded(session.health);
  const canCreate =
    !!boundWs &&
    !!selectedModel &&
    !degraded &&
    models.some((m) => m.id === selectedModel && m.available) &&
    !creating;

  const client = useCallback(() => {
    if (!session.hubBaseUrl || !session.deviceToken) {
      throw new HubApiError(401, 'NOT_PAIRED', 'Not paired');
    }
    return createHubClient({
      baseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
    });
  }, [session.hubBaseUrl, session.deviceToken]);

  const hubClient = useMemo(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return null;
    return createHubClient({
      baseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
    });
  }, [session.hubBaseUrl, session.deviceToken]);

  const applyInject = useCallback((params: NewSessionDeepLinkParams | null | undefined) => {
    if (!params) return;
    if (params.prompt?.trim()) {
      setPrompt(params.prompt.trim());
    }
    const model = params.model?.trim();
    if (model) {
      injectModelRef.current = model;
      setSelectedModel(model);
    }
    const atts = normalizeAttachPaths(params.attach);
    if (atts.length > 0) {
      setAttachments(atts);
    }
    if (isNewSessionAutoCreate(params)) {
      wantAutoCreateRef.current = true;
    }
  }, []);

  // Deep-link / adb inject — navigation params + Linking (query often dropped on remount).
  useEffect(() => {
    let cancelled = false;
    applyInject(routeParams);

    const applyUrl = (url: string | null | undefined) => {
      if (cancelled) return;
      applyInject(parseNewSessionDeepLink(url));
    };

    void Linking.getInitialURL().then((url) => {
      if (!cancelled) applyUrl(url);
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (!cancelled) applyUrl(url);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [routeParams, applyInject]);

  const loadSheetData = useCallback(async () => {
    if (!boundWs) return;
    setBusy(true);
    setLoadError(null);
    try {
      const hub = client();
      try {
        const modelsRes = await hub.getWorkspaceModels(true);
        const prevCount = models.length;
        setModels(modelsRes.models);
        setModelsNote(modelSourceLabel(modelsRes.source, modelsRes.note));
        const preferred = injectModelRef.current;
        const preferredOk =
          !!preferred &&
          modelsRes.models.some((m) => m.id === preferred && m.available);
        setSelectedModel(
          preferredOk ? preferred : pickDefaultModelId(modelsRes.models),
        );
        const emptyMsg = modelsDisappearedMessage(
          prevCount,
          modelsRes.models.length,
        );
        if (emptyMsg) {
          setLoadError(emptyMsg);
        }
      } catch (err) {
        if (err instanceof HubApiError && err.isRouteMissing) {
          setModels([]);
          setSelectedModel(null);
          setModelsNote(null);
          setLoadError(
            'GET /workspace/models not on Hub yet. Create disabled until models route ships.',
          );
        } else {
          throw err;
        }
      }

      try {
        const tools = await hub.getWorkspaceTools();
        const mcp = tools.summary.mcpServers?.length ?? 0;
        const plugins = tools.summary.plugins?.length ?? 0;
        setToolsNote(
          tools.summary.note ??
            `Tools run on PC · ${mcp} MCP server(s) · ${plugins} plugin(s)` +
              (tools.source ? ` · source=${tools.source}` : ''),
        );
      } catch (err) {
        if (err instanceof HubApiError && err.isRouteMissing) {
          setToolsNote('No tool summary from PC (route not available) — approvals still apply later.');
        }
      }
    } catch (err) {
      if (err instanceof HubApiError && err.status === 401) {
        // Keep the token: a 401 can come from a Hub restarted with another data dir.
        // Pair overwrites it on success; Account → Clear pairing still wipes it.
        navigation.replace('Pair');
        return;
      }
      if (err instanceof HubApiError) {
        setLoadError(`${err.code}: ${err.message}`);
      } else {
        setLoadError(err instanceof Error ? err.message : 'Failed to load sheet');
      }
    } finally {
      setBusy(false);
    }
  }, [boundWs, client, navigation]);

  // Deep links / process restart keep pair token but drop in-memory workspace —
  // rehydrate from Hub before showing unbound empty state.
  useEffect(() => {
    if (boundWs) return;
    if (!session.hubBaseUrl || !session.deviceToken || !session.bootstrapped) return;
    let cancelled = false;
    void (async () => {
      try {
        const hub = createHubClient({
          baseUrl: session.hubBaseUrl!,
          deviceToken: session.deviceToken!,
        });
        const [health, workspace] = await Promise.all([
          hub.getHealth(),
          hub.getWorkspace(),
        ]);
        if (cancelled) return;
        setHealthAndWorkspace(health, workspace);
      } catch {
        // leave unbound UI; operator can open Health + Refresh
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    boundWs,
    session.hubBaseUrl,
    session.deviceToken,
    session.bootstrapped,
    session,
  ]);

  useEffect(() => {
    void loadSheetData();
  }, [loadSheetData]);

  const create = useCallback(async () => {
    if (!boundWs || !selectedModel) return;
    const modelOk = models.some((m) => m.id === selectedModel && m.available);
    if (!modelOk) return;
    setCreating(true);
    setCreateError(null);
    setQueueBanner(null);
    try {
      const created = await client().createSession({
        workspaceId: boundWs.workspaceId,
        model: selectedModel,
        attachments,
        prompt: prompt.trim() || undefined,
        agentMode,
      });
      if (isQueuedCreateSession(created)) {
        setAwaitingQueue(true);
        setQueueBanner(createQueueBannerText('queuing'));
        return;
      }
      const fallbackTitle = prompt.trim() || 'New session';
      navigation.replace('LiveChat', {
        sessionId: created.id,
        title: created.title ?? fallbackTitle,
      });
    } catch (err) {
      if (err instanceof HubApiError && err.status === 401) {
        // Keep the token: a 401 can come from a Hub restarted with another data dir.
        // Pair overwrites it on success; Account → Clear pairing still wipes it.
        navigation.replace('Pair');
        return;
      }
      // Older Hub without queue: still surface Queuing when CDP is down.
      if (
        err instanceof HubApiError &&
        (err.code === 'CDP_UNAVAILABLE' || err.code === 'CURSOR_DOWN')
      ) {
        setAwaitingQueue(true);
        setQueueBanner(createQueueBannerText('queuing'));
        setCreateError(`${err.code}: ${err.message}`);
        return;
      }
      if (err instanceof HubApiError) {
        setCreateError(`${err.code}: ${err.message}`);
      } else {
        setCreateError(err instanceof Error ? err.message : 'Create failed');
      }
    } finally {
      setCreating(false);
    }
  }, [
    boundWs,
    selectedModel,
    models,
    client,
    attachments,
    prompt,
    agentMode,
    navigation,
    session,
  ]);

  // Poll Hub health while a create is queued — navigate when drain succeeds.
  useEffect(() => {
    if (!awaitingQueue) return;
    if (!session.hubBaseUrl || !session.deviceToken) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const hub = createHubClient({
          baseUrl: session.hubBaseUrl!,
          deviceToken: session.deviceToken!,
        });
        const health = await hub.getHealth();
        if (cancelled) return;
        setHealthAndWorkspace(health, session.workspace);
        const status = createQueueStatusFromHealth(health, true);
        setQueueBanner(createQueueBannerText(status));
        const drainedId = drainedSessionIdFromHealth(health);
        if (drainedId && (health.sessionCreateQueue?.pending ?? 0) === 0) {
          setAwaitingQueue(false);
          navigation.replace('LiveChat', {
            sessionId: drainedId,
            title: prompt.trim() || 'New session',
          });
        }
      } catch {
        // Keep polling — Hub may be briefly unreachable on mesh flap.
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    awaitingQueue,
    session.hubBaseUrl,
    session.deviceToken,
    session,
    navigation,
    prompt,
  ]);

  // Adb UAT: deep-link inject sets React state then auto-fires Create (no TextInput).
  // Allow POST even when live path is degraded so Hub still sees non-empty prompt
  // (UAT evidence); Create button remains disabled via canCreate when degraded.
  useEffect(() => {
    if (!wantAutoCreateRef.current || autoCreateDoneRef.current) return;
    if (busy || creating || !boundWs || !selectedModel) return;
    if (!models.some((m) => m.id === selectedModel && m.available)) return;
    // Require non-empty prompt for auto path — proves inject, not empty Create.
    if (!prompt.trim()) return;
    autoCreateDoneRef.current = true;
    void create();
  }, [busy, creating, boundWs, selectedModel, models, prompt, create]);

  if (!boundWs) {
    return (
      <View style={styles.root} testID="new-session-unbound">
        <Text style={styles.title}>New chat</Text>
        <Text style={styles.body} testID="new-session-empty-guidance">
          {unboundWorkspaceCreateGuidance()}
        </Text>
        <Pressable
          style={styles.button}
          onPress={() => navigation.goBack()}
          testID="new-session-close"
        >
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root} testID="new-session-screen">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>New chat</Text>
        <Text style={styles.subtitle} testID="new-session-workspace-name">
          {boundWs.name}
        </Text>
        <Text style={styles.path} testID="new-session-workspace-path">
          {boundWs.path}
        </Text>

        {degraded ? (
          <Text style={styles.warn} testID="new-session-degraded">
            {livePathDegradedReason(session.health)}
          </Text>
        ) : null}
        {queueBanner ? (
          <Text style={styles.warn} testID="new-session-queue-banner">
            {queueBanner}
          </Text>
        ) : null}
        {loadError ? (
          <Text style={styles.warn} testID="new-session-load-error">
            {loadError}
          </Text>
        ) : null}
        {createError ? (
          <Text style={styles.error} testID="new-session-create-error">
            {createError}
          </Text>
        ) : null}
        {busy ? <ActivityIndicator color={colors.accent} testID="new-session-loading" /> : null}

        <Text style={styles.label}>Model</Text>
        {modelsNote ? (
          <Text style={styles.body} testID="new-session-models-note">
            {modelsNote}
          </Text>
        ) : null}
        {models.length === 0 ? (
          <Text style={styles.body} testID="new-session-models-empty">
            {EMPTY_MODELS_BODY}
          </Text>
        ) : (
          <View style={styles.chipRow} testID="new-session-models">
            {models.map((m) => {
              const selected = m.id === selectedModel;
              return (
                <Pressable
                  key={m.id}
                  style={[
                    styles.chip,
                    selected && styles.chipSelected,
                    !m.available && styles.chipDisabled,
                  ]}
                  disabled={!m.available}
                  onPress={() => setSelectedModel(m.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  testID={`new-session-model-${m.id}`}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {m.label || m.id}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <Text style={styles.label}>Mode</Text>
        <View style={styles.chipRow} testID="new-session-modes">
          {AGENT_MODE_OPTIONS.map((m) => {
            const selected = m.id === agentMode;
            return (
              <Pressable
                key={m.id}
                style={[styles.chip, selected && styles.chipSelected]}
                onPress={() => setAgentMode(m.id)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                testID={`new-session-mode-${m.id}`}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.body}>
          Mode is sent on create via Hub. Live mid-chat mode switch is designed.
        </Text>

        <Text style={styles.label}>Attachments</Text>
        <View style={styles.chipRow} testID="new-session-attachments">
          {attachments.map((p) => (
            <Pressable
              key={p}
              style={styles.attachChip}
              onPress={() => setAttachments((prev) => toggleAttachment(prev, p))}
              testID={`new-session-attach-chip-${shortPath(p)}`}
            >
              <Text style={styles.chipText}>{shortPath(p)} ×</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          testID="new-session-add-files"
        >
          <Text style={styles.secondaryButtonText}>Add files from workspace</Text>
        </Pressable>
        <Pressable
          style={styles.linkBtn}
          onPress={() => navigation.navigate('Editor')}
          accessibilityRole="button"
          testID="new-session-editor-link"
        >
          <Text style={styles.link}>Optional: browse in Editor tab</Text>
        </Pressable>

        <Text style={styles.label}>Tools (info)</Text>
        <Text style={styles.body} testID="new-session-tools-note">
          {toolsNote ?? 'Loading…'}
        </Text>

        <Text style={styles.label}>First prompt (optional)</Text>
        <TextInput
          style={styles.prompt}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Optional opening message for Composer on PC"
          placeholderTextColor={colors.muted}
          multiline
          accessibilityLabel="First prompt"
          testID="new-session-prompt"
        />

        <View style={styles.footer}>
          <Pressable
            style={styles.secondaryButton}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            testID="new-session-cancel"
          >
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, !canCreate && styles.buttonDisabled]}
            disabled={!canCreate}
            onPress={() => void create()}
            accessibilityRole="button"
            accessibilityLabel="Create session"
            testID="new-session-create"
          >
            {creating ? (
              <ActivityIndicator color={colors.accentText} />
            ) : (
              <Text style={styles.buttonText}>Create</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>

      {hubClient ? (
        <FilePickerSheet
          visible={pickerOpen}
          workspace={boundWs}
          selected={attachments}
          onChangeSelected={setAttachments}
          onClose={() => setPickerOpen(false)}
          client={hubClient}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  path: { color: colors.muted, fontSize: 12, fontFamily: 'monospace' },
  label: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: spacing.sm },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  warn: { color: colors.warn, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipDisabled: { opacity: 0.4 },
  chipText: { color: colors.text, fontSize: 13 },
  chipTextSelected: { color: colors.accent, fontWeight: '700' },
  attachChip: {
    borderRadius: 8,
    backgroundColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  prompt: {
    minHeight: 96,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    color: colors.text,
    textAlignVertical: 'top',
  },
  footer: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  button: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: colors.border },
  buttonText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
  secondaryButton: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  secondaryButtonText: { color: colors.text, fontWeight: '600' },
  linkBtn: { alignSelf: 'flex-start' },
  link: {
    color: colors.muted,
    textDecorationLine: 'underline',
    fontSize: 13,
  },
});
