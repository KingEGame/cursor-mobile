import { requireOptionalNativeModule } from 'expo';

interface NativeHermesBackground {
  configure(urls: string[], token: string, pcName: string): void;
  stop(): void;
  setForeground(foreground: boolean): void;
  isRunning(): boolean;
}

const native = requireOptionalNativeModule<NativeHermesBackground>('HermesBackground');

/**
 * Background notifications (Android): a foreground service holds its own WebSocket to the phone bridge and
 * posts "Hermes replied" when a phone session goes idle while the app is not on screen.
 * No-op where the native module is missing (tests, iOS, Expo Go).
 */
export const HermesBackground = {
  available: native != null,
  /** Start (or reconfigure) the service. `urls` best first; the token stays in app-private storage. */
  configure(urls: string[], token: string, pcName: string): void {
    native?.configure(urls, token, pcName);
  },
  stop(): void {
    native?.stop();
  },
  /** While the app is on screen the service stays quiet (the UI already shows the reply). */
  setForeground(foreground: boolean): void {
    native?.setForeground(foreground);
  },
  isRunning(): boolean {
    return native?.isRunning() ?? false;
  },
};
