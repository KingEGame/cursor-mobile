import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootNav } from '../navigation/types';
import { colors, spacing, type, weight } from '../theme';
import { AccountScreen } from './AccountScreen';
import { ChatsHomeScreen } from './ChatsHomeScreen';

interface Props {
  navigation: RootNav;
}

type TabId = 'chats' | 'account';

/**
 * Bottom tabs: Chats | Account only (Gemini-like). Approvals stay in chat.
 */
export function MainTabsScreen({ navigation }: Props) {
  const [tab, setTab] = useState<TabId>('chats');
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {tab === 'chats' ? (
          <ChatsHomeScreen navigation={navigation} onOpenAccount={() => setTab('account')} />
        ) : (
          <AccountScreen navigation={navigation} />
        )}
      </View>
      <View
        style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}
        testID="main-tab-bar"
      >
        <Pressable
          style={styles.tab}
          onPress={() => setTab('chats')}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'chats' }}
          testID="tab-chats"
        >
          <Text style={tab === 'chats' ? styles.tabActive : styles.tabIdle}>Chats</Text>
        </Pressable>
        <Pressable
          style={styles.tab}
          onPress={() => setTab('account')}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'account' }}
          testID="tab-account"
        >
          <Text style={tab === 'account' ? styles.tabActive : styles.tabIdle}>
            Account
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: spacing.sm,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  tabActive: {
    color: colors.accent,
    fontSize: type.body,
    fontWeight: weight.semibold,
  },
  tabIdle: {
    color: colors.muted,
    fontSize: type.body,
    fontWeight: weight.semibold,
  },
});
