/**
 * Audio recording module for the phone bridge.
 * Uses expo-audio for push-to-talk recording with beep start/stop.
 */
import { RecordingPresets, setAudioModeAsync, type AudioRecorder, type RecordingStatus } from 'expo-audio';

// ── Recording log ────────────────────────────────────────────────────────────
export interface RecordingLogEntry {
  recordingId: string;
  path: string;
  sha256: string;
  size: number;
  startedBy: 'user';
  startedAt: number;
  uploaded: boolean;
}

// In-memory recording log. Persisted via outbox.sqlite for upload state.
const recordings: RecordingLogEntry[] = [];

export function logRecording(entry: RecordingLogEntry): void {
  recordings.push(entry);
  // Keep last 100 in memory
  if (recordings.length > 100) recordings.shift();
}

export function getRecordings(): readonly RecordingLogEntry[] {
  return recordings;
}

// ── Recording options ────────────────────────────────────────────────────────
/** High-quality audio recording options for the phone bridge. */
export const PHONE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    extension: '.wav',
    outputFormat: 2, // AAC_ADTS = 2 on Android
  },
};

// ── Beep generation ──────────────────────────────────────────────────────────
/**
 * Generate a beep tone as a WAV blob.
 * Returns a data URL that can be played with an AudioPlayer.
 * Duration ~150ms, frequency 440Hz (start) / 880Hz (stop).
 */
export function generateBeepDataUrl(frequency: number, durationMs = 150): string {
  const sampleRate = 44100;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  // 8-bit WAV
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);

  // WAV header
  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 1, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);

  // Samples — envelope to avoid click
  const fadeSamples = Math.min(Math.floor(numSamples * 0.1), 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Sine wave, 50% volume, with fade-in/out envelope
    let envelope = 1;
    if (i < fadeSamples) envelope = i / fadeSamples;
    if (i > numSamples - fadeSamples) envelope = (numSamples - i) / fadeSamples;
    const sample = Math.sin(2 * Math.PI * frequency * t) * 127 * 0.5 * envelope + 128;
    view.setUint8(44 + i, Math.max(0, Math.min(255, Math.round(sample))));
  }

  // Convert to data URL
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export const BEEP_START = generateBeepDataUrl(440);  // 440 Hz — A4
export const BEEP_STOP = generateBeepDataUrl(880);    // 880 Hz — A5

// ── Permission helper ────────────────────────────────────────────────────────
import { requestRecordingPermissionsAsync, getRecordingPermissionsAsync } from 'expo-audio';

export async function requestRecordingPermission(): Promise<boolean> {
  const { granted } = await requestRecordingPermissionsAsync();
  return granted;
}

export async function getRecordingPermission(): Promise<boolean> {
  const { granted } = await getRecordingPermissionsAsync();
  return granted;
}

// ── Background recording ─────────────────────────────────────────────────────
/** Enable background recording (Android foreground service). */
export async function enableBgRecording(recorder: AudioRecorder): Promise<void> {
  try {
    // expo-audio manages background recording via the plugin; this tells the
    // native module that background audio recording should be enabled.
    // The actual enableBackgroundRecordingAsync was removed; the plugin
    // handles it automatically when enableBackgroundRecording is set.
    // We call record() with the right options which triggers the native
    // foreground service automatically on Android.
  } catch {
    // non-critical
  }
}

// ── ID generation ────────────────────────────────────────────────────────────
export function newRecordingId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `rec_${Date.now().toString(36)}_${rnd}`;
}

// ── Audio session ────────────────────────────────────────────────────────────
export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: 'mixWithOthers',
  });
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}