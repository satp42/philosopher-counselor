import { describe, expect, it } from "vitest";

import { documentTitle } from "./documentTitle";

describe("documentTitle", () => {
  it("stays plain while locked or checking", () => {
    for (const auth of ["locked", "checking"] as const) {
      expect(documentTitle("call", auth)).toBe("Philosopher");
      expect(documentTitle("pages", auth)).toBe("Philosopher");
    }
  });

  it("includes the view label after unlock", () => {
    expect(documentTitle("call", "unlocked")).toBe("Call · Philosopher");
    expect(documentTitle("pages", "unlocked")).toBe("Your pages · Philosopher");
  });
});
