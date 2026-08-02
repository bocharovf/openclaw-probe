import { describe, expect, it } from "vitest";
import { slugify } from "./paths.js";

describe("slugify", () => {
  it("lowercases and dashes spaces", () => {
    expect(slugify("My Cool Experiment")).toBe("my-cool-experiment");
  });

  it("collapses repeated separators and trims edges", () => {
    expect(slugify("  weird///name!! ")).toBe("weird-name");
  });

  it("falls back to a default for an empty/unusable name", () => {
    expect(slugify("   ")).toBe("probe");
    expect(slugify("###")).toBe("probe");
  });

  it("keeps dots, dashes, and underscores", () => {
    expect(slugify("v1.2_test-run")).toBe("v1.2_test-run");
  });
});
