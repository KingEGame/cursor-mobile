import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  getStateFromPath as getStateFromPathDefault,
  type InitialState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PairScreen } from './src/screens/PairScreen';
import { HealthScreen } from './src/screens/HealthScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { MainTabsScreen } from './src/screens/MainTabsScreen';
import { LiveChatScreen } from './src/screens/LiveChatScreen';
import { HistoryReadScreen } from './src/screens/HistoryReadScreen';
import { NewSessionScreen } from './src/screens/NewSessionScreen';
import { EditorScreen } from './src/screens/EditorScreen';
import { UpdateScreen } from './src/screens/UpdateScreen';
import {
  AppSessionProvider,
  useAppSession,
} from './src/session/AppSessionContext';
import {
  isPairTokenInject,
  parsePairDeepLink,
  softDecode,
  type PairDeepLinkParams,
} from './src/navigation/pair-deep-link';
import { parseNewSessionDeepLink } from './src/navigation/new-session-deep-link';
import { normalizeHubBaseUrl } from './src/storage/hub-url';
import { getDefaultHubUrl, savePairingSuccess } from './src/storage/pairing';
import type { RootStackParamList } from './src/navigation/types';
import { colors } from './src/theme';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Deep links for adb / operator shortcuts (scheme from app.config). */
const linking = {
  prefixes: ['cursor-companion://'],
  config: {
    screens: {
      Pair: {
        path: 'pair',
        parse: {
          code: softDecode,
          pairId: softDecode,
          host: softDecode,
          port: softDecode,
          hubUrl: softDecode,
          auto: softDecode,
          deviceToken: softDecode,
          deviceId: softDecode,
          hubDisplayName: softDecode,
        },
      },
      Health: 'health',
      Main: 'main',
      Home: 'home',
      LiveChat: {
        path: 'live/:sessionId',
        parse: {
          sessionId: softDecode,
        },
      },
      HistoryRead: {
        path: 'history/:sessionId',
        parse: {
          sessionId: softDecode,
        },
      },
      NewSession: {
        path: 'new',
        parse: {
          prompt: softDecode,
          model: softDecode,
          attach: softDecode,
          auto: softDecode,
        },
      },
      Editor: 'editor',
    },
  },
  getStateFromPath(path: string, options: Parameters<typeof getStateFromPathDefault>[1]) {
    // cursor-companion://live-send/<sessionId>/<prefill> → LiveChat + autosend
    const trimmed = path.replace(/^\//, '');
    const m = /^live-send\/([^/]+)\/(.+)$/.exec(trimmed);
    if (m) {
      return {
        routes: [
          {
            name: 'LiveChat' as const,
            params: {
              sessionId: softDecode(m[1]!),
              prefill: softDecode(m[2]!),
              autosend: true,
            },
          },
        ],
      };
    }
    if (trimmed === 'nav/home') {
      return { routes: [{ name: 'Main' as const }] };
    }
    // pair?hubUrl=&deviceToken=&deviceId=… (token inject) or pair?code=
    const pairParams = parsePairDeepLink(trimmed);
    if (pairParams && (trimmed.toLowerCase().startsWith('pair'))) {
      return { routes: [{ name: 'Pair' as const, params: pairParams }] };
    }
    // new?prompt=&model=&attach=&auto= — RN often drops custom-scheme query
    const newParams = parseNewSessionDeepLink(trimmed);
    if (newParams && trimmed.toLowerCase().startsWith('new')) {
      return { routes: [{ name: 'NewSession' as const, params: newParams }] };
    }
    return getStateFromPathDefault(path, options);
  },
};

function pathFromCompanionUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const m = /^cursor-companion:\/\/\/?(.*)$/i.exec(trimmed);
  return m ? m[1]!.replace(/^\//, '') : null;
}

function hubBaseFromPairParams(params: PairDeepLinkParams): string {
  if (params.hubUrl?.trim()) {
    return normalizeHubBaseUrl(params.hubUrl);
  }
  if (params.host?.trim()) {
    const host = params.host.trim();
    const port = (params.port || '8787').trim();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return getDefaultHubUrl();
    }
    return normalizeHubBaseUrl(`http://${host}:${port}`);
  }
  return getDefaultHubUrl();
}

function stateFromCompanionUrl(url: string | null | undefined): InitialState | undefined {
  if (!url) return undefined;
  // Explicit pair?query parse — RN getStateFromPath often drops query on custom schemes.
  const pairParams = parsePairDeepLink(url);
  if (pairParams) {
    // Token already applied in AppNavigation — open Health directly.
    if (isPairTokenInject(pairParams)) {
      return { routes: [{ name: 'Health' }] };
    }
    return { routes: [{ name: 'Pair', params: pairParams }] };
  }
  // Explicit new?query parse — same custom-scheme query drop issue as pair.
  const newParams = parseNewSessionDeepLink(url);
  if (newParams) {
    return { routes: [{ name: 'NewSession', params: newParams }] };
  }
  const path = pathFromCompanionUrl(url);
  if (!path) return undefined;
  const state = linking.getStateFromPath(path, linking.config);
  return state ?? undefined;
}

/** Persist PC-side pairComplete token before the navigator picks Pair vs Health. */
async function applyTokenInjectFromUrl(
  url: string | null | undefined,
): Promise<boolean> {
  const params = parsePairDeepLink(url);
  if (!isPairTokenInject(params) || !params) return false;
  const base = hubBaseFromPairParams(params);
  if (!base) return false;
  await savePairingSuccess({
    hubBaseUrl: base,
    deviceToken: params.deviceToken!.trim(),
    deviceId: params.deviceId!.trim(),
    hubDisplayName: params.hubDisplayName?.trim() || 'Desk PC',
  });
  return true;
}

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

function RootNavigator() {
  const session = useAppSession();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (session.bootstrapped) {
      setReady(true);
    }
  }, [session.bootstrapped]);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // UI-SPEC locked decision #2: daily reopen with a token lands on Chats; Health is
  // reached after pairing or from Account.
  const initialRouteName: keyof RootStackParamList = session.deviceToken
    ? 'Main'
    : 'Pair';

  return (
    <Stack.Navigator
      initialRouteName={initialRouteName}
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen
        name="Pair"
        component={PairScreen}
        options={{ title: 'Pair', headerShown: false }}
      />
      <Stack.Screen name="Health" component={HealthScreen} options={{ title: 'Health' }} />
      <Stack.Screen
        name="Main"
        component={MainTabsScreen}
        options={{ headerShown: false, title: 'Chats' }}
      />
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{ headerShown: false, title: 'Chats' }}
      />
      <Stack.Screen
        name="LiveChat"
        component={LiveChatScreen}
        options={{ title: 'Chat' }}
      />
      <Stack.Screen
        name="HistoryRead"
        component={HistoryReadScreen}
        options={{ title: 'Chat' }}
      />
      <Stack.Screen
        name="NewSession"
        component={NewSessionScreen}
        options={{ title: 'New chat', presentation: 'modal' }}
      />
      <Stack.Screen
        name="Editor"
        component={EditorScreen}
        options={{ title: 'Browse files' }}
      />
      <Stack.Screen
        name="Update"
        component={UpdateScreen}
        options={{ title: 'App update', presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}

function AppNavigation() {
  const session = useAppSession();
  const [linkReady, setLinkReady] = useState(false);
  const [initialState, setInitialState] = useState<InitialState | undefined>();
  /** Bump to remount NavigationContainer when a late VIEW intent injects a token. */
  const [navEpoch, setNavEpoch] = useState(0);

  useEffect(() => {
    if (!session.bootstrapped) return;
    let cancelled = false;
    let injectApplied = false;

    const commitInject = async (url: string) => {
      if (injectApplied) return false;
      if (!(await applyTokenInjectFromUrl(url))) return false;
      injectApplied = true;
      await session.refreshFromStorage();
      if (cancelled) return true;
      setInitialState({ routes: [{ name: 'Health' }] });
      setNavEpoch((n) => n + 1);
      return true;
    };

    (async () => {
      try {
        const url = await Linking.getInitialURL();
        if (url) {
          if (!(await commitInject(url))) {
            const state = stateFromCompanionUrl(url);
            if (state && !cancelled) setInitialState(state);
          }
        }
      } finally {
        if (!cancelled) setLinkReady(true);
      }
    })();

    // Repair script re-fires VIEW after cold start; getInitialURL is often null then.
    const sub = Linking.addEventListener('url', ({ url }) => {
      void commitInject(url);
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [session.bootstrapped, session.refreshFromStorage]);

  if (!session.bootstrapped || !linkReady) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer
      key={`nav-${navEpoch}`}
      theme={navTheme}
      linking={linking}
      initialState={initialState}
    >
      <StatusBar style="dark" />
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppSessionProvider>
        <AppNavigation />
      </AppSessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
