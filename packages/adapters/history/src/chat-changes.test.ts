/**
 * Chat changes — diff counts, new/deleted files, and refusing to diff what we can't.
 */
import { describe, expect, it } from "vitest";
import { diffFile } from "./chat-changes.js";

const origin = (original: string | null, isNew = false) => ({ path: "/p/a.ts", isNew, original });

describe("diffFile", () => {
  it("counts added and removed lines against the original", () => {
    const d = diffFile(0, origin("a\nb\nc\n"), { text: "a\nB\nc\nd\n", skipped: null });
    expect(d).toMatchObject({ added: 2, removed: 1, deleted: false, skipped: null });
    expect(d.hunks[0]!.lines).toEqual([" a", "-b", "+B", " c", "+d"]);
  });

  it("treats a newly created file as all additions", () => {
    const d = diffFile(1, origin(null, true), { text: "x\ny\n", skipped: null });
    expect(d).toMatchObject({ isNew: true, added: 2, removed: 0 });
  });

  it("marks a file removed from disk as deleted", () => {
    const d = diffFile(2, origin("x\n"), { text: null, skipped: null });
    expect(d).toMatchObject({ deleted: true, added: 0, removed: 1 });
  });

  it("skips files it cannot diff instead of guessing", () => {
    expect(diffFile(3, origin("x"), { text: null, skipped: "Binary file" }).skipped).toBe("Binary file");
    expect(diffFile(4, origin(null), { text: "x", skipped: null }).skipped).toBe("Original not recorded by Cursor");
  });
});
