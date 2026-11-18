/**
 * Record conversation screen — push-to-talk audio recording.
 * Press and hold to record, release to stop. Beep on start/stop.
 * After recording: sha256 -> outbox -> tus upload.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAudioPlayer, useAudioRecorder, useAudioPlayerStatus, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import { useBridge } from '../bridge/BridgeProvider';
import {
  BEEP_START,
  BEEP_STOP,
  configureAudioSession,
  formatDuration,
  getRecordingPermission,
  logRecording,
  newRecordingId,
  requestRecordingPermission,
} from '../audio/recording';
import { enqueueUpload, processQueue, sha256File } from '../bridge/outbox';
import type { ScreenProps } from '../navigation/types';
import { colors, radii, spacing, type, weight } from '../theme';

type RecordingState = 'idle' | 'requesting' | 'recording' | 'saving' | 'done';

export function RecordConversationScreen({ navigation }: ScreenProps<'Record'>) {
  const bridge = useBridge();
  const [recordState, setRecordState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // Audio session setup once on mount
  useEffect(() => {
    void configureAudioSession();
  }, []);

  // Recorder — created once, lifecycle managed by the hook
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // Beep players
  const startBeep = useAudioPlayer(BEEP_START);
  const stopBeep = useAudioPlayer(BEEP_STOP);

  // Duration polling
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (recordState === 'recording' && recorder.isRecording) {
      timerRef.current = setInterval(() => {
        setDuration(Math.floor(recorder.currentTime));
      }, 200);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recordState, recorder.isRecording, recorder.currentTime]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setUploadStatus(null);
      setRecordState('requesting');

      let hasPerm = await getRecordingPermission();
      if (!hasPerm) {
        hasPerm = await requestRecordingPermission();
      }
      if (!hasPerm) {
        setError('Microphone permission is required.');
        setRecordState('idle');
        return;
      }
      if (!bridge.pairing.token) {
        setError('Pair your phone with a PC first.');
        setRecordState('idle');
        return;
      }

      setRecordState('recording');
      setDuration(0);
      startedAtRef.current = Math.floor(Date.now() / 1000);

      // Play start beep before recording
      startBeep.play();
      // Small delay so the beep plays before mic is live
      setTimeout(() => recorder.record(), 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRecordState('idle');
    }
  }, [bridge.pairing.token, recorder, startBeep]);

  const stopRecording = useCallback(async () => {
    if (!recorder.isRecording) return;
    try {
      setRecordState('saving');
      const recordingId = newRecordingId();
      const startedAt = startedAtRef.current;

      // Play stop beep before stopping
      stopBeep.play();
      await recorder.stop();
      setDuration(0);

      const uri = recorder.uri;
      if (!uri) {
        setError('Recording produced no output file.');
        setRecordState('idle');
        return;
      }

      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) {
        setError('Recording file not found on disk.');
        setRecordState('idle');
        return;
      }

      const size = info.size ?? 0;
      if (size < 1024) {
        setError('Recording too short (< 1 KB).');
        setRecordState('idle');
        return;
      }

      setUploadStatus('Checksumming…');
      const sha256 = await sha256File(uri);

      setUploadStatus('Queuing upload…');
      await enqueueUpload(recordingId, uri, sha256, size, startedAt);

      logRecording({
        recordingId,
        path: uri,
        sha256,
        size,
        startedBy: 'user',
        startedAt,
        uploaded: false,
      });

      // Process queue immediately
      setUploadStatus('Uploading…');
      const result = await processQueue(bridge.client);
      setUploadStatus(
        result.ok > 0 ? 'Recording uploaded to PC.' : 'Queued — uploads will continue in background.',
      );
      setRecordState('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Upload problem: ${msg}`);
      setRecordState('idle');
    }
  }, [recorder, bridge.client, stopBeep]);

  const reset = useCallback(() => {
    setRecordState('idle');
    setDuration(0);
    setError(null);
    setUploadStatus(null);
  }, []);

  const handlePressIn = useCallback(() => void startRecording(), [startRecording]);
  const handlePressOut = useCallback(() => void stopRecording(), [stopRecording]);

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        <Text style={styles.heading}>Record conversation</Text>
        <Text style={styles.subtitle}>
          Press and hold to record. Release to stop.
        </Text>

        {recordState === 'recording' && (
          <View style={styles.recordingIndicator}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingDuration}>{formatDuration(duration)}</Text>
          </View>
        )}

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {uploadStatus && (
          <Text style={styles.uploadStatus}>{uploadStatus}</Text>
        )}

        <TouchableOpacity
          style={[
            styles.recordButton,
            recordState === 'recording' && styles.recordButtonActive,
            (recordState === 'saving' || recordState === 'requesting') && styles.recordButtonDisabled,
          ]}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={recordState === 'saving' || recordState === 'requesting'}
          activeOpacity={0.7}
          testID="record-button"
        >
          <View style={styles.recordButtonInner}>
            {recordState === 'recording' ? (
              <View style={styles.stopIcon} />
            ) : (
              <Text style={styles.micEmoji}>🎤</Text>
            )}
          </View>
          <Text style={styles.recordButtonLabel}>
            {recordState === 'recording' ? 'Release to stop'
            : recordState === 'saving' ? 'Saving…'
            : recordState === 'requesting' ? 'Preparing…'
            : 'Hold to record'}
          </Text>
        </TouchableOpacity>

        {recordState === 'done' && (
          <TouchableOpacity style={styles.resetButton} onPress={reset} testID="reset-button">
            <Text style={styles.resetButtonText}>Record another</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: spacing.lg, gap: spacing.lg,
  },
  heading: { fontSize: type.title, fontWeight: weight.semibold, color: colors.text, textAlign: 'center' },
  subtitle: { fontSize: type.body, color: colors.muted, textAlign: 'center', maxWidth: 280 },
  recordingIndicator: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.dangerSoft, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, borderRadius: radii.pill,
  },
  recordingDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.danger },
  recordingDuration: {
    fontSize: type.body, fontWeight: weight.semibold,
    color: colors.dangerText, fontFamily: 'monospace',
  },
  errorBox: { backgroundColor: colors.dangerSoft, borderRadius: radii.md, padding: spacing.md, maxWidth: 320 },
  errorText: { fontSize: type.meta, color: colors.dangerText, lineHeight: 18 },
  uploadStatus: { fontSize: type.meta, color: colors.muted, textAlign: 'center' },
  recordButton: {
    width: 160, height: 160, borderRadius: 80,
    backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 4,
  },
  recordButtonActive: { backgroundColor: colors.danger, width: 180, height: 180, borderRadius: 90 },
  recordButtonDisabled: { opacity: 0.6 },
  recordButtonInner: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  stopIcon: { width: 30, height: 30, borderRadius: 4, backgroundColor: colors.onDark },
  micEmoji: { fontSize: 36 },
  recordButtonLabel: {
    fontSize: type.meta, color: colors.onDark,
    fontWeight: weight.semibold, marginTop: spacing.sm, textAlign: 'center',
  },
  resetButton: {
    marginTop: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border,
  },
  resetButtonText: { fontSize: type.body, color: colors.accent, fontWeight: weight.semibold },
});