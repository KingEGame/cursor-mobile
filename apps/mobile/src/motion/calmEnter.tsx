import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

/**
 * Calm enter: opacity + slight translateY (scale never below 0.95).
 * Reduce Motion → opacity-only / instant final state (Amendment G).
 */
export function CalmEnter(props: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Max one enter motion per screen — optional disable. */
  enabled?: boolean;
}) {
  const enabled = props.enabled !== false;
  const opacity = useRef(new Animated.Value(enabled ? 0 : 1)).current;
  const translateY = useRef(new Animated.Value(enabled ? 10 : 0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (!cancelled) setReduceMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener?.(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (reduceMotion) {
      opacity.setValue(1);
      translateY.setValue(0);
      return;
    }
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [enabled, reduceMotion, opacity, translateY]);

  return (
    <Animated.View
      style={[
        props.style,
        {
          opacity,
          transform: reduceMotion ? undefined : [{ translateY }],
        },
      ]}
    >
      {props.children}
    </Animated.View>
  );
}
