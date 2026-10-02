import { requireOptionalNativeModule } from 'expo';

interface PcWatchNative {
  start(baseUrl: string, token: string, hubName: string): boolean;
  stop(): boolean;
  isRunning(): boolean;
}

/** Null on platforms/builds without the native module (iOS, tests) — callers no-op. */
export const PcWatch = requireOptionalNativeModule<PcWatchNative>('PcWatch');
