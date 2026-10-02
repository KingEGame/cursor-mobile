/**
 * Durable queue storage for Phase 4 (NFR-OFF-04).
 * Uses SecureStore JSON blob — tokens stay in pairing keys; queue has no secrets.
 */
import * as SecureStore from 'expo-secure-store';
import type { OutboundQueueItem, QueueStorage } from './outbound-queue';

const QUEUE_KEY = 'outbound_queue_v1';

function isQueueItem(value: unknown): value is OutboundQueueItem {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (o.kind === 'message') {
    return (
      typeof o.id === 'string' &&
      typeof o.sessionId === 'string' &&
      typeof o.content === 'string' &&
      typeof o.idempotencyKey === 'string' &&
      typeof o.createdAt === 'string' &&
      (o.status === 'pending' || o.status === 'flushing' || o.status === 'failed')
    );
  }
  if (o.kind === 'approval') {
    return (
      typeof o.id === 'string' &&
      typeof o.sessionId === 'string' &&
      typeof o.approvalId === 'string' &&
      (o.decision === 'approve' || o.decision === 'deny') &&
      typeof o.idempotencyKey === 'string' &&
      typeof o.createdAt === 'string' &&
      (o.status === 'pending' || o.status === 'flushing' || o.status === 'failed')
    );
  }
  return false;
}

export function createSecureQueueStorage(): QueueStorage {
  return {
    async load() {
      const raw = await SecureStore.getItemAsync(QUEUE_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isQueueItem);
      } catch {
        return [];
      }
    },
    async save(items) {
      if (items.length === 0) {
        await SecureStore.deleteItemAsync(QUEUE_KEY);
        return;
      }
      await SecureStore.setItemAsync(QUEUE_KEY, JSON.stringify(items));
    },
  };
}
