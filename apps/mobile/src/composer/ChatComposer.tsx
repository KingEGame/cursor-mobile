import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  ArrowUp,
  Camera,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Pencil,
  Plug,
  Plus,
  Slash,
  Square,
  X,
} from 'lucide-react-native';
import type { HubClient } from '../hub/client';
import { MODES, canSend, composerPayload, mentionChipLabel, modeInfo, sameMention } from '../hub/composer';
import type { AgentMode, ComposerOptions, MentionRef, PhonePhoto, WorkspaceModel } from '../hub/types';
import { colors, radii, spacing } from '../theme';
import { MentionPicker, type PickerKind } from './MentionPicker';
import { pickPhoto } from './photos';

export interface ComposerSubmit {
  text: string;
  options: ComposerOptions;
}

/**
 * Cursor-style composer (UI-SPEC Amendment B): round "+" with modes, files, skills,
 * plugins, photos and model; chips above the input; Send turns into Stop while the agent
 * runs. Everything is applied on the PC by the Hub and verified there.
 */
export function ChatComposer(props: {
  client: HubClient | null;
  /** Chat on the PC; null for a brand-new chat (file/skill pickers need a chat). */
  composerId: string | null;
  running: boolean;
  busy: boolean;
  bottomInset: number;
  placeholder?: string;
  /** Editing an earlier message: the text to start from (null = normal compose). */
  editingText?: string | null;
  onCancelEdit?: () => void;
  onSubmit: (payload: ComposerSubmit) => Promise<boolean>;
  onStop?: () => void;
}) {
  const { client, composerId, running, busy, editingText, onCancelEdit, onSubmit, onStop } = props;
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [mentions, setMentions] = useState<MentionRef[]>([]);
  const [images, setImages] = useState<PhonePhoto[]>([]);
  const [sheet, setSheet] = useState<'plus' | 'model' | null>(null);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [models, setModels] = useState<WorkspaceModel[] | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const editing = editingText != null;
  useEffect(() => {
    if (editingText != null) setText(editingText);
  }, [editingText]);

  useEffect(() => {
    if (sheet !== 'model' || models || !client) return;
    client
      .getWorkspaceModels()
      .then((res) => setModels(res.models.filter((m) => m.available)))
      .catch(() => setModels([]));
  }, [sheet, models, client]);

  const addMention = (ref: MentionRef) =>
    setMentions((prev) => (prev.some((m) => sameMention(m, ref)) ? prev : [...prev, ref]));

  const addPhoto = async (source: 'camera' | 'library') => {
    setSheet(null);
    setPhotoBusy(true);
    try {
      const photo = await pickPhoto(source);
      if (photo) setImages((prev) => [...prev, photo].slice(0, 4));
    } finally {
      setPhotoBusy(false);
    }
  };

  const submit = async () => {
    if (!canSend(text, busy)) return;
    const ok = await onSubmit({
      text: text.trim(),
      options: editing ? {} : composerPayload({ mode, model, mentions, images }),
    });
    if (ok) {
      setText('');
      setMentions([]);
      setImages([]);
      // Mode and model stay — Cursor keeps them for the chat too.
    }
  };

  const showStop = running && !text.trim() && !editing && !!onStop;
  const info = modeInfo(mode);
  const hasChips = !editing && (mode || mentions.length > 0 || images.length > 0);

  return (
    <View style={[styles.wrap, { paddingBottom: spacing.sm + props.bottomInset }]}>
      {editing ? (
        <View style={styles.editBar}>
          <Pencil size={14} color={colors.warn} />
          <Text style={styles.editText}>Editing an earlier message — Cursor re-runs from there</Text>
          <Pressable onPress={onCancelEdit} hitSlop={8} accessibilityLabel="Cancel edit">
            <X size={18} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      {hasChips ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {info ? (
            <Chip color={info.color} label={info.mode} onRemove={() => setMode(null)} />
          ) : null}
          {mentions.map((m) => (
            <Chip
              key={mentionChipLabel(m) + (m.detail ?? '')}
              label={mentionChipLabel(m)}
              onRemove={() => setMentions((prev) => prev.filter((x) => !sameMention(x, m)))}
            />
          ))}
          {images.map((img, i) => (
            <View key={img.name + i} style={styles.thumbWrap}>
              <Image source={{ uri: `data:${img.mime};base64,${img.base64}` }} style={styles.thumb} />
              <Pressable
                style={styles.thumbX}
                onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                accessibilityLabel="Remove photo"
              >
                <X size={12} color={colors.accentText} />
              </Pressable>
            </View>
          ))}
          {photoBusy ? <ActivityIndicator color={colors.accent} /> : null}
        </ScrollView>
      ) : null}

      <View style={styles.row}>
        {!editing ? (
          <Pressable
            style={styles.plus}
            onPress={() => setSheet('plus')}
            accessibilityRole="button"
            accessibilityLabel="Composer actions"
            testID="composer-plus"
          >
            <Plus size={20} color={colors.text} strokeWidth={1.75} />
          </Pressable>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={info?.placeholder ?? props.placeholder ?? 'Message the agent on your PC'}
          placeholderTextColor={colors.muted}
          style={styles.input}
          multiline
          accessibilityLabel="Message"
          testID="chat-input"
        />
        {showStop ? (
          <Pressable
            onPress={onStop}
            style={[styles.send, styles.stop]}
            accessibilityRole="button"
            accessibilityLabel="Stop the agent"
            testID="chat-stop"
          >
            <Square size={16} color={colors.accentText} fill={colors.accentText} />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void submit()}
            disabled={!canSend(text, busy)}
            style={[styles.send, !canSend(text, busy) && styles.sendDisabled]}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Save and resend' : 'Send message'}
            testID="chat-send"
          >
            {busy ? (
              <ActivityIndicator color={colors.accentText} size="small" />
            ) : (
              <ArrowUp size={20} color={colors.accentText} strokeWidth={2.25} />
            )}
          </Pressable>
        )}
      </View>

      {!editing ? (
        <Pressable style={styles.modelPill} onPress={() => setSheet('model')} accessibilityLabel="Select model">
          <Text style={styles.modelText}>Model {model ?? 'as on PC'}</Text>
          <ChevronRight size={14} color={colors.muted} />
        </Pressable>
      ) : null}

      <Modal visible={sheet === 'plus'} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSheet(null)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetLabel}>Mode</Text>
            <View style={styles.modes}>
              {MODES.map((m) => (
                <Pressable
                  key={m.mode}
                  style={[styles.modeCard, { backgroundColor: m.color }, mode === m.mode && styles.modeSelected]}
                  onPress={() => {
                    setMode(mode === m.mode ? null : m.mode);
                    setSheet(null);
                  }}
                >
                  <Text style={styles.modeName}>{m.mode}</Text>
                  <Text style={styles.modeSub} numberOfLines={2}>
                    {m.subtitle}
                  </Text>
                </Pressable>
              ))}
            </View>
            <SheetRow icon={FileText} label="Files" sub="From this project on the PC" disabled={!composerId}
              onPress={() => { setSheet(null); setPicker('files'); }} />
            <SheetRow icon={Slash} label="Skills & rules" sub="Cursor “/” commands" disabled={!composerId}
              onPress={() => { setSheet(null); setPicker('skills'); }} />
            <SheetRow icon={Plug} label="Plugins (MCP)" sub="Cursor “@” MCP servers" disabled={!composerId}
              onPress={() => { setSheet(null); setPicker('plugins'); }} />
            <SheetRow icon={Camera} label="Take photo" sub="Attach a camera picture" onPress={() => void addPhoto('camera')} />
            <SheetRow icon={ImageIcon} label="Choose photo" sub="From the phone gallery" onPress={() => void addPhoto('library')} />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={sheet === 'model'} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSheet(null)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetLabel}>Model</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              <SheetRow label="As on PC" sub="Keep whatever the PC chat uses" selected={!model}
                onPress={() => { setModel(null); setSheet(null); }} />
              {models === null ? <ActivityIndicator color={colors.accent} /> : null}
              {models?.map((m) => (
                <SheetRow key={m.id} label={m.label} selected={model === m.label}
                  onPress={() => { setModel(m.label); setSheet(null); }} />
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {composerId ? (
        <MentionPicker
          visible={picker !== null}
          kind={picker ?? 'files'}
          client={client}
          composerId={composerId}
          onPick={addMention}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </View>
  );
}

function Chip(props: { label: string; color?: string; onRemove: () => void }) {
  return (
    <View style={[styles.chip, props.color ? { backgroundColor: props.color } : null]}>
      <Text style={styles.chipText} numberOfLines={1}>
        {props.label}
      </Text>
      <Pressable onPress={props.onRemove} hitSlop={8} accessibilityLabel={`Remove ${props.label}`}>
        <X size={14} color={colors.muted} />
      </Pressable>
    </View>
  );
}

function SheetRow(props: {
  icon?: typeof Plus;
  label: string;
  sub?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const Icon = props.icon;
  return (
    <Pressable
      style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed, props.disabled && styles.disabled]}
      onPress={props.onPress}
      disabled={props.disabled}
    >
      {Icon ? <Icon size={20} color={colors.text} strokeWidth={1.75} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={[styles.sheetRowLabel, props.selected && { color: colors.accent, fontWeight: '700' }]}>
          {props.label}
        </Text>
        {props.sub ? <Text style={styles.sheetRowSub}>{props.sub}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  editBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  editText: { flex: 1, color: colors.warn, fontSize: 12 },
  chips: { gap: spacing.xs, alignItems: 'center', paddingVertical: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    minHeight: 30,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
    maxWidth: 220,
  },
  chipText: { color: colors.text, fontSize: 13, flexShrink: 1 },
  thumbWrap: { width: 44, height: 44 },
  thumb: { width: 44, height: 44, borderRadius: 8 },
  thumbX: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  plus: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#f7f8fa',
    borderWidth: 1,
    borderColor: '#c5c9d0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 16,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stop: { backgroundColor: colors.danger },
  sendDisabled: { backgroundColor: colors.border },
  modelPill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 2, minHeight: 24 },
  modelText: { color: colors.muted, fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  sheetLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: spacing.xs },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  modeCard: { width: '48%', borderRadius: radii.sm, padding: spacing.sm, minHeight: 64 },
  modeSelected: { borderWidth: 2, borderColor: colors.text },
  modeName: { color: colors.text, fontWeight: '700', fontSize: 15 },
  modeSub: { color: colors.text, fontSize: 12, opacity: 0.75 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 52, paddingHorizontal: spacing.xs },
  sheetRowLabel: { color: colors.text, fontSize: 16 },
  sheetRowSub: { color: colors.muted, fontSize: 12 },
  pressed: { backgroundColor: colors.surfaceMuted },
  disabled: { opacity: 0.4 },
});
