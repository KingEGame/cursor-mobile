/**
 * Record / replay hooks for selector packs (TOR-06 testing).
 *
 * Record: capture DOM HTML snippets (+ metadata) while CDP is on loopback.
 * Replay: assert candidate strategies hit fixtures without a live Cursor.
 *
 * CDP must remain 127.0.0.1 only — never record from remote CDP URLs.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  firstMatchingStrategy,
  strategyLikelyHits,
  textMatchHits,
} from "./selector-match.js";
import type {
  ActionSelector,
  SelectorActionId,
  SelectorPack,
} from "./selector-pack.js";

export interface SelectorFixture {
  /** Stable fixture id. */
  id: string;
  action: SelectorActionId;
  /** Cursor UI generation / build note at record time. */
  recordedAgainst: string;
  recordedAt: string;
  /** HTML snippet from Composer / tool card / model picker. */
  domSnippet: string;
  /**
   * Strategies expected to hit this fixture (subset of pack strategies).
   * Empty → replay asserts at least one pack strategy OR textMatch hits.
   */
  expectedStrategyHits?: string[];
  notes?: string;
}

export interface ReplayHitResult {
  fixtureId: string;
  action: SelectorActionId;
  ok: boolean;
  matchedStrategy: string | null;
  textMatchOk: boolean;
  missingExpected: string[];
  detail: string;
}

export interface RecordCaptureInput {
  action: SelectorActionId;
  domSnippet: string;
  recordedAgainst: string;
  notes?: string;
  expectedStrategyHits?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

/** Default fixtures directory (package-local). */
export function defaultFixturesDir(): string {
  return join(here, "..", "fixtures", "selector-pack");
}

export function loadFixtureFile(path: string): SelectorFixture {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as SelectorFixture;
}

export function loadFixturesFromDir(
  dir: string = defaultFixturesDir(),
): SelectorFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => loadFixtureFile(join(dir, f)));
}

/**
 * Build a fixture object from a live/manual DOM capture (record hook).
 * Does not write disk unless `writeTo` is set.
 */
export function recordFixture(
  input: RecordCaptureInput,
  opts?: { id?: string; writeTo?: string },
): SelectorFixture {
  const fixture: SelectorFixture = {
    id: opts?.id ?? `${input.action}-${Date.now()}`,
    action: input.action,
    recordedAgainst: input.recordedAgainst,
    recordedAt: new Date().toISOString(),
    domSnippet: input.domSnippet,
    expectedStrategyHits: input.expectedStrategyHits,
    notes: input.notes,
  };
  if (opts?.writeTo) {
    mkdirSync(dirname(opts.writeTo), { recursive: true });
    writeFileSync(opts.writeTo, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  }
  return fixture;
}

export function replayFixtureAgainstAction(
  fixture: SelectorFixture,
  action: ActionSelector,
): ReplayHitResult {
  const matchedStrategy = firstMatchingStrategy(
    fixture.domSnippet,
    action.strategies,
  );
  const textOk = textMatchHits(fixture.domSnippet, action.textMatch);
  const expected = fixture.expectedStrategyHits ?? [];
  const missingExpected = expected.filter(
    (s) => !strategyLikelyHits(fixture.domSnippet, s),
  );

  const anyHit = matchedStrategy !== null || textOk;
  const expectedOk = missingExpected.length === 0;
  const ok = anyHit && expectedOk;

  return {
    fixtureId: fixture.id,
    action: fixture.action,
    ok,
    matchedStrategy,
    textMatchOk: textOk,
    missingExpected,
    detail: ok
      ? `hit via ${matchedStrategy ?? "textMatch"}`
      : `no strategy/textMatch hit (or missing expected: ${missingExpected.join(", ") || "n/a"})`,
  };
}

/**
 * Replay all fixtures for a pack. Failures mean pack strategies drifted vs fixtures —
 * production should stay extractor_stale until pack + fixtures are updated together.
 */
export function replayPackFixtures(
  pack: SelectorPack,
  fixtures: SelectorFixture[],
): ReplayHitResult[] {
  return fixtures.map((fx) => {
    const action = pack.actions[fx.action];
    if (!action) {
      return {
        fixtureId: fx.id,
        action: fx.action,
        ok: false,
        matchedStrategy: null,
        textMatchOk: false,
        missingExpected: [],
        detail: `unknown action ${fx.action}`,
      };
    }
    return replayFixtureAgainstAction(fx, action);
  });
}

/** Assert helpers for tests. */
export function assertReplayAllOk(results: ReplayHitResult[]): void {
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    const lines = failed.map((f) => `  - ${f.fixtureId}: ${f.detail}`).join("\n");
    throw new Error(`Selector replay failed:\n${lines}`);
  }
}
