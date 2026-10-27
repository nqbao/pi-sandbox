import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyReadOnlyOverride, assertSandboxProviderAvailable, applyCommandPrefix, describeBackgroundProcesses, readShellSettings, resolveStartupOverrides } from "./index.ts";
import { homedir } from "node:os";
import { join } from "node:path";
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

describe("describeBackgroundProcesses", () => {
  it("reflects allowBackgroundProcesses on Linux", () => {
    assert.equal(describeBackgroundProcesses("bubblewrap", false), "killed when the command exits");
    assert.equal(describeBackgroundProcesses("bubblewrap", true), "kept running (no PID namespace)");
  });

  it("says background jobs keep running on macOS whatever the setting", () => {
    for (const allow of [false, true]) {
      assert.match(describeBackgroundProcesses("sandbox-exec", allow), /^kept running .*only applies on Linux/);
    }
  });
});

describe("readShellSettings", () => {
  type Pi = Parameters<typeof readShellSettings>[0];
  const withSettings = (settings: Record<string, unknown>): Pi => ({ getSettings: () => settings as ReturnType<Pi["getSettings"]> });

  it("returns Pi's shellPath and shellCommandPrefix settings", () => {
    const warnings: string[] = [];
    const result = readShellSettings(withSettings({ shellPath: "/opt/bash", shellCommandPrefix: "shopt -s expand_aliases" }), (m) => warnings.push(m));
    assert.deepEqual(result, { shellPath: "/opt/bash", commandPrefix: "shopt -s expand_aliases" });
    assert.deepEqual(warnings, []);
  });

  it("expands a leading ~ in shellPath like Pi does", () => {
    assert.equal(readShellSettings(withSettings({ shellPath: "~/bin/bash" }), () => {}).shellPath, join(homedir(), "bin/bash"));
  });

  it("returns nothing when the settings are unset", () => {
    assert.deepEqual(readShellSettings(withSettings({}), () => {}), { shellPath: undefined, commandPrefix: undefined });
  });

  it("warns when this Pi version has no getSettings", () => {
    const warnings: string[] = [];
    assert.deepEqual(readShellSettings({} as Pi, (m) => warnings.push(m)), {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /shellPath and shellCommandPrefix settings are ignored/);
  });

  it("returns nothing without warning before the runtime is initialized", () => {
    const warnings: string[] = [];
    const notInitialized = () => {
      throw new Error("Extension runtime not initialized");
    };
    assert.deepEqual(readShellSettings({ getSettings: notInitialized }, (m) => warnings.push(m)), {});
    assert.deepEqual(warnings, []);
  });
});

describe("applyCommandPrefix", () => {
  it("puts the prefix on its own line before the command, like Pi's bash tool", () => {
    assert.equal(applyCommandPrefix("ls", "source ~/.aliases"), "source ~/.aliases\nls");
    assert.equal(applyCommandPrefix("ls", undefined), "ls");
  });
});
