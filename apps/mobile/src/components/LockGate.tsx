import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { loadLockSettings, unlock } from '../security/app-lock';
import { shouldRelock } from '../security/lock-policy';
import { colors, radii, spacing, type, weight } from '../theme';

/**
 * Covers the app until the owner unlocks, when Account → Security → "Lock app on open" is on.
 * Locks at cold start and after 5 minutes in the background.
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  const tryUnlock = useCallback(async () => {
    const { lockOpen } = await loadLockSettings();
    if (!lockOpen) {
      setLocked(false);
      return;
    }
    setLocked(true);
    if (await unlock(true, 'Unlock Cursor Mobile')) setLocked(false);
  }, []);

  useEffect(() => {
    void tryUnlock();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active') {
        if (shouldRelock(backgroundedAt.current, Date.now())) void tryUnlock();
        backgroundedAt.current = null;
      }
    });
    return () => sub.remove();
  }, [tryUnlock]);

  return (
    <View style={styles.root}>
      {children}
      {locked ? (
        <View style={styles.cover}>
          <Text style={styles.title}>Locked</Text>
          <Pressable
            style={styles.btn}
            onPress={() => void tryUnlock()}
            accessibilityRole="button"
            testID="lock-unlock"
          >
            <Text style={styles.btnText}>Unlock</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  title: { color: colors.text, fontSize: type.sub, fontWeight: weight.semibold },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.xl,
    minHeight: 48,
    justifyContent: 'center',
  },
  btnText: { color: colors.accentText, fontSize: type.body, fontWeight: weight.semibold },
});
