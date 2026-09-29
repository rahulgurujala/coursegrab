// Proves the test runner itself works. Replaced by real coverage as each module is ported
// (phase 5 of the rewrite plan adds the first real tests, for rangeDownloader and planUpdates).
import { describe, expect, it } from "vitest";

describe("toolchain smoke test", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
