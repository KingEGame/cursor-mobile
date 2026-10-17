import { useHeaderHeight } from '@react-navigation/elements';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Check, Folder } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatComposer, type ComposerSubmit } from '../composer/ChatComposer';
import { createHubClient } from '../hub/client';
import { HubApiError, type AgentsProjectRow } from '../hub/types';
import type { RootStackParamList } from '../navigation/types';
import { loadLockSettings, unlock } from '../security/app-lock';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing, type, weight } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'NewAgentChat'>;

/**
 * New chat in one of the PC's Agents projects. The Hub clicks that project's "New Agent"
 * on the PC, proves a fresh chat opened there, then types the first message.
 */
export function NewAgentChatScreen({ navigation, route }: Props) {
  const headerHeight = useHeaderHeight();
  const session = useAppSession();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<AgentsProjectRow[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(route.params?.projectId ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = useMemo(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return null;
    return createHubClient({ baseUrl: session.hubBaseUrl, deviceToken: session.deviceToken });
  }, [session.hubBaseUrl, session.deviceToken]);

  useEffect(() => {
    if (!client) return;
    client
      .listAgents()
      .then((res) => {
        if (res.source !== 'sidebar') {
          setError('Cursor on the PC is not reachable right now — new chats need it open.');
        }
        setProjects(res.projects);
        setProjectId((current) => current ?? res.projects[0]?.projectId ?? null);
      })
      .catch(() => setError('Could not load projects from the PC'));
  }, [client]);

  const create = async ({ text, options }: ComposerSubmit): Promise<boolean> => {
    if (!client || !projectId || sending) return false;
    setSending(true);
    setError(null);
    try {
      const { lockSend } = await loadLockSettings();
      if (!(await unlock(lockSend, 'Unlock to start a chat on your PC'))) {
        setError('Not sent — unlock was cancelled');
        return false;
      }
      const res = await client.newAgentChat(projectId, text, options);
      if (res.sessionId) {
        navigation.replace('HistoryRead', { sessionId: res.sessionId, title: text.slice(0, 60) });
      } else {
        navigation.goBack();
      }
      return true;
    } catch (err) {
      setError(err instanceof HubApiError ? `Not started — ${err.message}` : 'Not started — check the connection');
      return false;
    } finally {
      setSending(false);
    }
  };

  const chosen = projects?.find((p) => p.projectId === projectId);

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Project on your PC</Text>
        {!projects ? <ActivityIndicator color={colors.accent} /> : null}
        {projects?.map((p) => {
          const selected = p.projectId === projectId;
          return (
            <Pressable
              key={p.projectId}
              onPress={() => setProjectId(p.projectId)}
              style={[styles.project, selected && styles.projectSelected]}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <Folder size={18} color={colors.muted} strokeWidth={1.75} />
              <Text style={styles.projectName} numberOfLines={1}>
                {p.name}
              </Text>
              {selected ? <Check size={18} color={colors.accent} strokeWidth={2} /> : null}
            </Pressable>
          );
        })}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <ChatComposer
        client={client}
        composerId={null}
        running={false}
        busy={sending || !projectId}
        bottomInset={insets.bottom}
        placeholder={chosen ? `Ask the agent in ${chosen.name}` : 'Message the agent'}
        onSubmit={create}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.xs },
  label: { color: colors.muted, fontSize: type.meta, fontWeight: weight.semibold, marginBottom: spacing.xs },
  project: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  projectSelected: { backgroundColor: colors.surfaceMuted },
  projectName: { flex: 1, color: colors.text, fontSize: type.body },
  error: { color: colors.danger, marginTop: spacing.sm },
});
