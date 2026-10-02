import React, { useMemo } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { parseMarkdown, type Block, type Span } from '../hub/markdown';
import { colors, spacing } from '../theme';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          style={[
            s.bold && styles.bold,
            s.italic && styles.italic,
            s.code && styles.inlineCode,
            s.link ? styles.link : null,
          ]}
          onPress={s.link ? () => void Linking.openURL(s.link!).catch(() => undefined) : undefined}
        >
          {s.text}
        </Text>
      ))}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text style={[styles.text, block.level <= 2 ? styles.h1 : styles.h3]} selectable>
          <Spans spans={block.spans} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text style={styles.text} selectable>
          <Spans spans={block.spans} />
        </Text>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={[styles.listRow, { paddingLeft: item.depth * spacing.md }]}>
              <Text style={[styles.text, styles.marker]}>{item.ordered ? item.marker : '•'}</Text>
              <Text style={[styles.text, styles.listText]} selectable>
                <Spans spans={item.spans} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'code':
      return (
        <ScrollView horizontal style={styles.codeBox} contentContainerStyle={styles.codeInner}>
          <Text style={styles.code} selectable>
            {block.text}
          </Text>
        </ScrollView>
      );
    case 'table':
      // Phone-width tables never fit: keep columns readable and scroll sideways.
      return (
        <ScrollView horizontal style={styles.table}>
          <View>
            {[block.header, ...block.rows].map((row, r) => (
              <View key={r} style={[styles.tr, r === 0 && styles.th]}>
                {row.map((cell, c) => (
                  <Text key={c} style={[styles.td, r === 0 && styles.bold]} selectable>
                    <Spans spans={cell} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
  }
}

/** Render an agent message's Markdown with phone-friendly blocks. */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  text: { color: colors.text, fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  inlineCode: {
    fontFamily: MONO,
    fontSize: 13,
    backgroundColor: colors.surfaceMuted,
  },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  h1: { fontSize: 17, fontWeight: '700', lineHeight: 24 },
  h3: { fontSize: 15, fontWeight: '700' },
  list: { gap: 2 },
  listRow: { flexDirection: 'row' },
  marker: { width: 22, color: colors.muted },
  listText: { flex: 1 },
  codeBox: { backgroundColor: colors.surfaceMuted, borderRadius: 6 },
  codeInner: { padding: spacing.sm },
  code: { fontFamily: MONO, fontSize: 12, lineHeight: 18, color: colors.text },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 6 },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  th: { backgroundColor: colors.surfaceMuted },
  td: {
    width: 160,
    padding: spacing.xs,
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
  },
});
