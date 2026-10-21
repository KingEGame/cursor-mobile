import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { HealthResponse, WorkspaceResponse } from '../hub/types';
import { clearPairing, loadPairingState } from '../storage/pairing';
import { createSecureQueueStorage } from '../queue/secure-storage';
import { OutboundQueue } from '../queue/outbound-queue';
import {
  deriveHealthLevel,
  type AppSession,
  type HealthDotLevel,
} from '../navigation/types';

export { deriveHealthLevel };

const sharedQueue = new OutboundQueue(createSecureQueueStorage());

interface AppSessionApi extends AppSession {
  refreshFromStorage: () => Promise<void>;
  setHealthAndWorkspace: (
    health: HealthResponse | null,
    workspace: WorkspaceResponse | null,
  ) => void;
  clearDevice: () => Promise<void>;
  /** Phase 4 offline outbound queue (FR-091). */
  outboundQueue: OutboundQueue;
}

const AppSessionContext = createContext<AppSessionApi | null>(null);

const initial: AppSession = {
  hubBaseUrl: '',
  deviceToken: null,
  deviceId: null,
  hubDisplayName: null,
  hubId: null,
  health: null,
  workspace: null,
  healthLevel: 'unknown',
  bootstrapped: false,
};

export function AppSessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppSession>(initial);

  const refreshFromStorage = useCallback(async () => {
    const pairing = await loadPairingState();
    setState((prev) => ({
      ...prev,
      hubBaseUrl: pairing.hubBaseUrl,
      deviceToken: pairing.deviceToken,
      deviceId: pairing.deviceId,
      hubDisplayName: pairing.hubDisplayName,
      hubId: pairing.hubId,
      bootstrapped: true,
    }));
  }, []);

  useEffect(() => {
    void refreshFromStorage();
  }, [refreshFromStorage]);

  const setHealthAndWorkspace = useCallback(
    (health: HealthResponse | null, workspace: WorkspaceResponse | null) => {
      setState((prev) => ({
        ...prev,
        health,
        workspace: workspace ?? prev.workspace,
        healthLevel: deriveHealthLevel(health),
      }));
    },
    [],
  );

  const clearDevice = useCallback(async () => {
    await clearPairing();
    await sharedQueue.clear();
    setState((prev) => ({
      ...prev,
      deviceToken: null,
      deviceId: null,
      hubDisplayName: null,
      hubId: null,
      health: null,
      workspace: null,
      healthLevel: 'unknown' as HealthDotLevel,
    }));
  }, []);

  const value = useMemo<AppSessionApi>(
    () => ({
      ...state,
      refreshFromStorage,
      setHealthAndWorkspace,
      clearDevice,
      outboundQueue: sharedQueue,
    }),
    [state, refreshFromStorage, setHealthAndWorkspace, clearDevice],
  );

  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>;
}

export function useAppSession(): AppSessionApi {
  const ctx = useContext(AppSessionContext);
  if (!ctx) {
    throw new Error('useAppSession must be used within AppSessionProvider');
  }
  return ctx;
}
