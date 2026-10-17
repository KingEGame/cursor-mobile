import { Vibration } from 'react-native';

export type Buzz = 'sent' | 'error' | 'approved';

/** Short physical confirmation. Never throws; the app works the same without it. */
export function buzz(kind: Buzz): void {
  try {
    if (kind === 'error') Vibration.vibrate([0, 40, 60, 40]);
    else Vibration.vibrate(kind === 'approved' ? 20 : 12);
  } catch {
    /* no vibrator */
  }
}
