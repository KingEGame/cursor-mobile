/**
 * HubWebSocket reconnect + URL helpers (phone ↔ Hub mesh only; never CDP).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildWsUrl, HubWebSocket, type HubWsConnectionState } from './ws';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Test helper: complete open handshake. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe('buildWsUrl', () => {
  it('maps http Hub base to /v1/ws with access_token', () => {
    const url = buildWsUrl('http://100.108.160.99:8787', 'tok_abc');
    assert.equal(
      url,
      'ws://100.108.160.99:8787/v1/ws?access_token=tok_abc',
    );
  });
});

describe('HubWebSocket reconnect', () => {
  it('reconnects after unexpected close with backoff', async () => {
    FakeSocket.instances = [];
    const states: HubWsConnectionState[] = [];
    const ws = new HubWebSocket({
      baseUrl: 'http://127.0.0.1:8787',
      deviceToken: 'tok',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      reconnect: true,
      reconnectInitialMs: 20,
      reconnectMaxMs: 50,
      onState: (s) => states.push(s),
    });

    ws.connect();
    assert.equal(FakeSocket.instances.length, 1);
    FakeSocket.instances[0]!.open();
    assert.ok(states.includes('open'));

    // Unexpected drop (intentionalClose=false)
    FakeSocket.instances[0]!.close();
    assert.ok(states.includes('closed'));

    await new Promise((r) => setTimeout(r, 80));
    assert.ok(
      FakeSocket.instances.length >= 2,
      'expected a reconnect socket after close',
    );

    ws.close();
  });

  it('does not reconnect after intentional close()', async () => {
    FakeSocket.instances = [];
    const ws = new HubWebSocket({
      baseUrl: 'http://127.0.0.1:8787',
      deviceToken: 'tok',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      reconnect: true,
      reconnectInitialMs: 10,
      onState: () => undefined,
    });
    ws.connect();
    FakeSocket.instances[0]!.open();
    const before = FakeSocket.instances.length;
    ws.close();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(FakeSocket.instances.length, before);
  });
});
