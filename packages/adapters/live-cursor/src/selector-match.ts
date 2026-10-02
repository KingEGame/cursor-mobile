/**
 * Lightweight CSS-ish matcher for record/replay fixtures (TOR-06).
 * Not a full CSS engine — covers the strategy shapes we ship in the pack:
 * class (incl. multi-class), id, attribute equality/contains, tag, and simple
 * descendant / child chains.
 */

function unescapeCssIdent(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** Parse a single simple selector (no combinators). */
function matchSimple(elHtml: string, simple: string): boolean {
  const s = simple.trim();
  if (!s) return false;

  // [attr*='val'] or [attr="val"] or [attr='val']
  const attrStar = s.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)\*=['"]([^'"]+)['"]\]$/);
  if (attrStar) {
    const tag = attrStar[1] ?? "";
    const attr = attrStar[2]!;
    const val = attrStar[3]!;
    if (tag && !new RegExp(`<${tag}\\b`, "i").test(elHtml)) return false;
    const re = new RegExp(
      `${attr}\\s*=\\s*["'][^"']*${escapeRegExp(val)}[^"']*["']`,
      "i",
    );
    return re.test(elHtml);
  }

  const attrEq = s.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)=['"]([^'"]+)['"]\]$/);
  if (attrEq) {
    const tag = attrEq[1] ?? "";
    const attr = attrEq[2]!;
    const val = attrEq[3]!;
    if (tag && !new RegExp(`<${tag}\\b`, "i").test(elHtml)) return false;
    const re = new RegExp(`${attr}\\s*=\\s*["']${escapeRegExp(val)}["']`, "i");
    return re.test(elHtml);
  }

  // .class or tag.class(.class)* — require every class token present
  const classChain = s.match(/^([a-zA-Z0-9_-]*)((?:\.(?:[a-zA-Z0-9_-]|\\.)+)+)$/);
  if (classChain) {
    const tag = classChain[1] ?? "";
    const rawClasses = classChain[2]!;
    const classes = [...rawClasses.matchAll(/\.((?:[a-zA-Z0-9_-]|\\.)+)/g)].map(
      (m) => unescapeCssIdent(m[1]!),
    );
    if (tag && !new RegExp(`<${tag}\\b`, "i").test(elHtml)) return false;
    return classes.every(
      (cls) =>
        new RegExp(
          `class\\s*=\\s*["'][^"']*\\b${escapeRegExp(cls)}\\b`,
          "i",
        ).test(elHtml) || elHtml.includes(cls),
    );
  }

  // #id
  const idMatch = s.match(/^#((?:[a-zA-Z0-9_-]|\\.)+)$/);
  if (idMatch) {
    const id = unescapeCssIdent(idMatch[1]!);
    return new RegExp(`id\\s*=\\s*["']${escapeRegExp(id)}["']`, "i").test(elHtml);
  }

  // bare tag
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)) {
    return new RegExp(`<${s}\\b`, "i").test(elHtml);
  }

  // Fallback: distinctive fragment present (escaped dots → literal)
  const frag = unescapeCssIdent(s.replace(/^[a-zA-Z0-9_-]+/, "").trim());
  if (frag.length > 2) {
    return elHtml.includes(frag.replace(/[[\]"'*=']/g, ""));
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a descendant selector on whitespace / child combinators while keeping
 * quoted attribute values intact (e.g. `[aria-label*='Add Context']`).
 */
export function splitSelectorParts(strategy: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  for (const ch of strategy.trim()) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    // Treat CSS descendant/child combinators as separators for soft matching
    if (/\s/.test(ch) || ch === ">") {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/**
 * Return true if the strategy would likely hit the fixture HTML snippet.
 * Descendant selectors (space-separated) require each simple part to appear
 * somewhere in the snippet (order-preserving soft check).
 */
export function strategyLikelyHits(html: string, strategy: string): boolean {
  const parts = splitSelectorParts(strategy);
  if (parts.length === 0) return false;

  let cursor = 0;
  for (const part of parts) {
    // Find a matching substring from cursor onward by scanning tags roughly.
    const from = html.slice(cursor);
    if (!matchSimple(from, part) && !matchSimple(html, part)) {
      return false;
    }
    // Advance cursor to first occurrence of a distinctive token when possible.
    const token =
      part.match(/\.((?:[a-zA-Z0-9_-]|\\.)+)/)?.[1] ??
      part.match(/#((?:[a-zA-Z0-9_-]|\\.)+)/)?.[1] ??
      part.match(/\*=\s*['"]([^'"]+)['"]/)?.[1] ??
      part.match(/=\s*['"]([^'"]+)['"]/)?.[1];
    if (token) {
      const unescaped = unescapeCssIdent(token);
      const idx = html.indexOf(unescaped, cursor);
      if (idx >= 0) cursor = idx + unescaped.length;
    }
  }
  return true;
}

export function firstMatchingStrategy(
  html: string,
  strategies: string[],
): string | null {
  for (const s of strategies) {
    if (strategyLikelyHits(html, s)) return s;
  }
  return null;
}

export function textMatchHits(html: string, textMatch: string[] | undefined): boolean {
  if (!textMatch || textMatch.length === 0) return false;
  return textMatch.some((t) => html.includes(t));
}
