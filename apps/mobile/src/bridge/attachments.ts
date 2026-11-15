/** Photo / camera / file pickers → `Attachment`s the bridge uploads (multipart). */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { Attachment } from './types';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // same cap as the bridge (per message)

function extFor(mime: string | null | undefined): string {
  if (!mime) return '';
  const sub = mime.split('/')[1] ?? '';
  return sub === 'jpeg' ? '.jpg' : sub ? `.${sub.replace(/[^a-z0-9]/gi, '')}` : '';
}

function fromImage(a: ImagePicker.ImagePickerAsset, i: number): Attachment {
  const mime = a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
  return {
    uri: a.uri,
    name: a.fileName ?? `${a.type === 'video' ? 'video' : 'photo'}_${Date.now()}_${i}${extFor(mime)}`,
    mime,
    size: a.fileSize ?? null,
  };
}

/** System photo picker (no storage permission needed on Android 13+). */
export async function pickPhotos(): Promise<Attachment[]> {
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    quality: 0.85,
  });
  return r.canceled ? [] : r.assets.map(fromImage);
}

export async function takePhoto(): Promise<Attachment[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Camera permission is needed to take a photo.');
  const r = await ImagePicker.launchCameraAsync({ quality: 0.85 });
  return r.canceled ? [] : r.assets.map(fromImage);
}

/** Any file via the system document picker (copied to the app cache so it can be uploaded). */
export async function pickFiles(): Promise<Attachment[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (r.canceled) return [];
  return r.assets.map((a) => ({
    uri: a.uri,
    name: a.name,
    mime: a.mimeType ?? 'application/octet-stream',
    size: a.size ?? null,
  }));
}

export function totalBytes(files: Attachment[]): number {
  return files.reduce((n, f) => n + (f.size ?? 0), 0);
}

export function humanSize(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
