import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyReadOnlyOverride, assertSandboxProviderAvailable, resolveStartupOverrides } from "./index.ts";
import type { SandboxConfig } from "./types.ts";

describe("applyReadOnlyOverride", () => {
  const config: SandboxConfig = {
    enabled: true,
    readOnly: false,
    denyRead: [],
    writable: ["/workspace", "/tmp"],
    denyWithin: ["/workspace/.git/hooks"],
    network: true,
  };

  it("leaves config unchanged when no runtime override is set", () => {
    assert.equal(applyReadOnlyOverride(config, undefined), config);
  });

  it("preserves writable paths in read-only mode (readOnly gates --ro-bind vs --bind, not writable)", () => {
    assert.deepEqual(applyReadOnlyOverride(config, true), {
      ...config,
      readOnly: true,
    });
  });
});

describe("assertSandboxProviderAvailable", () => {
  it("allows disabled sandbox with no provider", () => {
    assert.doesNotThrow(() => assertSandboxProviderAvailable(false, "none"));
  });

  it("allows enabled sandbox when a provider exists", () => {
    assert.doesNotThrow(() => assertSandboxProviderAvailable(true, "sandbox-exec"));
  });

  it("fails enabled sandbox when no provider exists", () => {
    assert.throws(
      () => assertSandboxProviderAvailable(true, "none"),
      /sandbox enabled but no supported OS sandbox provider is available/,
    );
  });
});

describe("resolveStartupOverrides", () => {
  it("enables sandbox and read-only mode when --sandbox-readonly is set", () => {
    assert.deepEqual(resolveStartupOverrides(false, false, true), {
      runtimeEnabledOverride: true,
      runtimeReadOnlyOverride: true,
      warnings: [],
    });
  });

  it("lets --no-sandbox win over --sandbox and ignores read-only in that case", () => {
    assert.deepEqual(resolveStartupOverrides(true, true, true), {
      runtimeEnabledOverride: false,
      runtimeReadOnlyOverride: false,
      warnings: [
        "[pi-sandbox] Both --sandbox and --no-sandbox were provided; --no-sandbox wins.",
        "[pi-sandbox] --sandbox-readonly is ignored when --no-sandbox is set.",
      ],
    });
  });
});
