import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, getProtectedConfigPaths } from "./config.ts";

describe("loadConfig", () => {
  it("always protects Pi sandbox config paths", () => {
    const { config } = loadConfig("/workspace");
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      assert.equal(
        config.denyWithin.includes(path),
        true,
        `expected protected config path ${path} to be denied`,
      );
    }
  });

  it("keeps protected config paths denied even if parent directories are writable", () => {
    const { config } = loadConfig("/workspace");
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      const parentDir = path.slice(0, path.lastIndexOf("/")) || "/";
      assert.equal(config.writable.includes(parentDir), false);
      assert.equal(config.denyWithin.includes(path), true);
    }
  });
});
