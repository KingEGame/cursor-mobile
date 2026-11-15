import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  /** Deep link / QR: `hermes-phone://pair?hubUrl=&code=&pairId=&name=` */
  Pair: { hubUrl?: string; code?: string; pairId?: string; name?: string } | undefined;
  Sessions: undefined;
  /** Existing session (`sessionId`) or a phone chat that may not have a session yet (`chatId`). */
  Chat: { sessionId?: string; chatId?: string; title?: string };
  Settings: undefined;
};

export type ScreenProps<K extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, K>;
