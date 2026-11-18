import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  /** Deep link / QR: `hermes-phone://pair?hubUrl=&code=&pairId=&name=` */
  Pair: { hubUrl?: string; code?: string; pairId?: string; name?: string } | undefined;
  Sessions: undefined;
  Projects: undefined;
  Project: { slug: string; name?: string };
  /** Existing session (`sessionId`) or a phone chat that may not have a session yet (`chatId`). */
  Chat: { sessionId?: string; chatId?: string; title?: string; project?: string };
  Settings: undefined;
  Record: undefined;
  /** T15: Mate presence mirror — always-on status screen. */
  Mate: undefined;
};

export type ScreenProps<K extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, K>;
