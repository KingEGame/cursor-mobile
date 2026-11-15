import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { DefaultTheme, NavigationContainer, type LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BridgeProvider, useBridge } from './src/bridge/BridgeProvider';
import { LockGate } from './src/components/LockGate';
import type { RootStackParamList } from './src/navigation/types';
import { ChatScreen } from './src/screens/ChatScreen';
import { PairScreen } from './src/screens/PairScreen';
import { SessionsScreen } from './src/screens/SessionsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { colors } from './src/theme';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** `cursor-companion://pair?hubUrl=…&code=…`, `…://session/<id>`, `…://sessions`. */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['cursor-companion://', 'hermes-phone://'],
  config: {
    screens: {
      Pair: 'pair',
      Sessions: 'sessions',
      Chat: 'session/:sessionId',
      Settings: 'settings',
    },
  },
};

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

function Root() {
  const bridge = useBridge();
  if (!bridge.ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  return (
    <NavigationContainer theme={navTheme} linking={linking}>
      <StatusBar style="dark" />
      <LockGate>
        <Stack.Navigator
          initialRouteName={bridge.pairing.token ? 'Sessions' : 'Pair'}
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="Pair" component={PairScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Sessions" component={SessionsScreen} options={{ title: 'Hermes' }} />
          <Stack.Screen name="Chat" component={ChatScreen} options={{ title: 'Chat' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        </Stack.Navigator>
      </LockGate>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <BridgeProvider>
        <Root />
      </BridgeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
});
