import React, { useEffect } from 'react';
import type { RootNav } from '../navigation/types';

interface Props {
  navigation: RootNav;
}

/** Deep-link / UAT alias — immediately lands on Main tabs (Chats). */
export function HomeScreen({ navigation }: Props) {
  useEffect(() => {
    navigation.replace('Main');
  }, [navigation]);
  return null;
}
