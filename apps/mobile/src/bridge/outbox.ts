/**
 * Persistent SQLite outbox for audio recording uploads.
 * Survives app kill/reboot. Uses the bridge's own idempotent upload:
 * re-sending a completed sha256 returns "complete" immediately.
 */
import { openDatabaseAsync } from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import { TusClient } from './tus';
import type { BridgeClient } from './client';

export type OutboxState = 'queued' | 'uploading' | 'acked' | 'failed';

export interface OutboxRow {
  id: number;
  recordingId: string;
  path: string;
  sha256: string;
  size: number;
  state: OutboxState;
  uploadId: string | null;
  offset: number;
  attempts: number;
  lastError: string | null;
  startedAt: number;
  createdAt: number;
  ackedAt: number | null;
}

let db: Awaited<ReturnType<typeof openDatabaseAsync>> | null = null;

async function getDb() {
  if (db) return db;
  db = await openDatabaseAsync('outbox.db');
  await db.execAsync('PRAGMA journal_mode=WAL');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    state TEXT DEFAULT 'queued',
    upload_id TEXT,
    "offset" INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    started_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    acked_at INTEGER
  )`);
  return db;
}

/** Compute SHA-256 hex of a file. */
export async function sha256File(path: string): Promise<string> {
  const b64 = await FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes.buffer as ArrayBuffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

/** Inline SHA-256 of a Uint8Array (for chunk checksums). */
async function sha256Bytes(data: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Enqueue a new recording for upload. */
export async function enqueueUpload(
  recordingId: string,
  path: string,
  sha256: string,
  size: number,
  startedAt: number,
): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `INSERT OR IGNORE INTO outbox (recording_id, path, sha256, size, state, started_at, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    recordingId,
    path,
    sha256,
    size,
    startedAt,
    Date.now(),
  );
}

export async function nextQueued(): Promise<OutboxRow | null> {
  const d = await getDb();
  return (await d.getFirstAsync(
    `SELECT * FROM outbox WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1`,
  )) ?? null;
}

export async function pendingUploads(): Promise<OutboxRow[]> {
  const d = await getDb();
  return d.getAllAsync(
    `SELECT * FROM outbox WHERE state IN ('queued', 'uploading', 'failed') ORDER BY created_at ASC`,
  );
}

export async function getUploadCount(): Promise<number> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM outbox WHERE state IN ('queued', 'uploading', 'failed')`,
  );
  return row?.count ?? 0;
}

export async function markUploading(id: number, uploadId: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `UPDATE outbox SET state = 'uploading', upload_id = ?, attempts = attempts + 1 WHERE id = ?`,
    uploadId,
    id,
  );
}

export async function updateOffset(id: number, offset: number): Promise<void> {
  const d = await getDb();
  await d.runAsync(`UPDATE outbox SET "offset" = ? WHERE id = ?`, offset, id);
}

export async function markAcked(id: number): Promise<void> {
  const d = await getDb();
  await d.runAsync(`UPDATE outbox SET state = 'acked', acked_at = ? WHERE id = ?`, Date.now(), id);
}

export async function markFailed(id: number, error: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `UPDATE outbox SET state = 'failed', last_error = ? WHERE id = ?`,
    error,
    id,
  );
}

export async function pruneAcked(olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `DELETE FROM outbox WHERE state = 'acked' AND acked_at IS NOT NULL AND acked_at < ?`,
    Date.now() - olderThanMs,
  );
}

/** Process the upload queue: send all pending files via tus (one at a time). */
export async function processQueue(client: BridgeClient): Promise<{ ok: number; fail: number }> {
  const pending = await pendingUploads();
  if (!pending.length) return { ok: 0, fail: 0 };

  const tus = new TusClient(client);
  let ok = 0;
  let fail = 0;

  for (const row of pending) {
    try {
      // Check if file still exists
      const info = await FileSystem.getInfoAsync(row.path);
      if (!info.exists) {
        await markFailed(row.id, 'file not found on disk');
        fail++;
        continue;
      }

      // Create or resume upload (idempotent by sha256)
      const resp = await tus.create(row.sha256, row.size, row.recordingId);

      if (resp.complete) {
        await markAcked(row.id);
        await FileSystem.deleteAsync(row.path, { idempotent: true });
        ok++;
        continue;
      }

      await markUploading(row.id, resp.uploadId);

      // Upload in chunks
      let offset = resp.offset;
      const CHUNK = 4 * 1024 * 1024;

      while (offset < row.size) {
        const end = Math.min(offset + CHUNK, row.size);
        const chunkLen = end - offset;
        const b64 = await FileSystem.readAsStringAsync(row.path, {
          encoding: FileSystem.EncodingType.Base64,
          length: chunkLen,
          position: offset,
        });
        const raw = atob(b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

        const chunkHash = await sha256Bytes(bytes);

        // HEAD to confirm offset before each PATCH (app may have been backgrounded)
        if (offset > 0) {
          const head = await tus.head(resp.uploadId);
          offset = head.offset;
          await updateOffset(row.id, offset);
        }

        await tus.patch(resp.uploadId, bytes, offset, chunkHash);
        offset = end;
        await updateOffset(row.id, offset);
      }

      await markAcked(row.id);
      await FileSystem.deleteAsync(row.path, { idempotent: true });
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markFailed(row.id, msg);
      fail++;
    }
  }

  return { ok, fail };
}