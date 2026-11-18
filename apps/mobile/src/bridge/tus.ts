/**
 * Minimal tus 1.0 client for the phone bridge.
 * Uses fetch directly (auth via Bearer token).
 *
 * Server endpoints (T16):
 *   POST   /v1/uploads   — create {sha256, size, recordingId, kind, startedAt}
 *   HEAD   /v1/uploads/{uid} — get offset
 *   PATCH  /v1/uploads/{uid} — append chunk (Upload-Offset + Upload-Checksum)
 *   DELETE /v1/uploads/{uid} — cancel
 */
import type { BridgeClient } from './client';

export interface CreateResponse {
  uploadId: string;
  offset: number;
  complete: boolean;
  expiresAt?: string;
  sha256?: string;
  path?: string;
}

export interface HeadResponse {
  offset: number;
  size: number;
  expiresAt?: string;
}

export class TusClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly client: BridgeClient) {
    const c = client as unknown as {
      baseUrl: string;
      token: string | null;
      fetchImpl?: typeof fetch;
    };
    this.baseUrl = c.baseUrl;
    this.token = c.token;
    this.fetchImpl = c.fetchImpl ?? globalThis.fetch;
  }

  async create(
    sha256: string,
    size: number,
    recordingId: string,
    kind = 'audio',
    startedAt?: number,
  ): Promise<CreateResponse> {
    const body = JSON.stringify({
      sha256,
      size,
      recordingId,
      kind,
      startedAt: startedAt ?? Math.floor(Date.now() / 1000),
    });
    const res = await this.request('/v1/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    });
    if (!res.ok) throw await this.error(res);
    return res.json();
  }

  async head(uploadId: string): Promise<HeadResponse> {
    const res = await this.request(`/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'HEAD',
    });
    if (!res.ok) throw await this.error(res);
    return {
      offset: parseInt(res.headers.get('Upload-Offset') ?? '0', 10),
      size: parseInt(res.headers.get('Upload-Length') ?? '0', 10),
      expiresAt: res.headers.get('Upload-Expires') ?? undefined,
    };
  }

  async patch(uploadId: string, chunk: Uint8Array, offset: number, chunkSha256: string): Promise<void> {
    const res = await this.request(`/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Upload-Offset': String(offset),
        'Upload-Checksum': `sha256 ${chunkSha256}`,
      },
      body: chunk.buffer as ArrayBuffer,
    });
    if (!res.ok) throw await this.error(res);
  }

  async delete(uploadId: string): Promise<boolean> {
    const res = await this.request(`/v1/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
    });
    return res.ok;
  }

  private async request(path: string, opts: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.headers as Record<string, string> | undefined),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...opts, headers });
  }

  private async error(res: Response): Promise<Error> {
    try {
      const body = await res.json();
      const msg = body?.error?.message ?? body?.error?.code ?? `HTTP ${res.status}`;
      return new Error(`Tus upload failed: ${msg}`);
    } catch {
      return new Error(`Tus upload failed: HTTP ${res.status}`);
    }
  }
}