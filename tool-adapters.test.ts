import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { prepareSandboxedCommand, providers } from "./providers.ts";
import { bgRunLabel, toolAdapters } from "./tool-adapters.ts";
import type { SandboxConfig, SandboxProvider } from "./types.ts";

const bgRun = toolAdapters.get("bg_run")!;
const wrap = (command: string) => `WRAPPED ${command}`;

describe("toolAdapters", () => {
  it("matches tool names exactly", () => {
    for (const name of ["bg_runner", "BG_RUN", "bg_kill", "constructor"]) {
      assert.equal(toolAdapters.get(name), undefined);
    }
  });
});

describe("bg_run adapter", () => {
  it("rewrites the command in place and keeps a label from the original command", () => {
    const input: Record<string, unknown> = { command: "  npm   test" };
    assert.equal(bgRun.rewrite(input, wrap), undefined);
    assert.deepEqual(input, { command: "WRAPPED   npm   test", label: "npm test" });
  });

  it("keeps a label given by the caller", () => {
    const input: Record<string, unknown> = { command: "true", label: "mine" };
    bgRun.rewrite(input, wrap);
    assert.equal(input.label, "mine");
  });

  it("truncates labels the way pi-bg-run does", () => {
    assert.equal(bgRunLabel("x".repeat(51)), `${"x".repeat(47)}...`);
    assert.equal(bgRunLabel("x".repeat(50)), "x".repeat(50));
  });

  for (const command of ["", "  \n", undefined, 7]) {
    it(`rejects command ${JSON.stringify(command)} without sandboxing it`, () => {
      const input = { command };
      assert.match(String(bgRun.rewrite(input, wrap)), /non-empty string/);
      assert.deepEqual(input, { command });
    });
  }

  it("leaves the input alone when wrapping throws", () => {
    const input = { command: "true" };
    assert.throws(() => bgRun.rewrite(input, () => { throw new Error("nope"); }), /nope/);
    assert.deepEqual(input, { command: "true" });
  });
});

describe("prepareSandboxedCommand", () => {
  const config = { enabled: true, denyRead: [], writable: [], denyWithin: [], network: true } as SandboxConfig;
  const provider = (cleanup: () => void) =>
    ({ prepare: () => ({ executable: "printf", args: ["%s\\n"], cleanup }) }) as unknown as SandboxProvider;

  it("does not release resources on success", () => {
    let cleaned = 0;
    const prepared = prepareSandboxedCommand(provider(() => cleaned++), "true", "/w", "/w", config);
    assert.equal(cleaned, 0);
    prepared.cleanup?.();
    assert.equal(cleaned, 1);
  });

  it("releases resources when the command can't be built", () => {
    let cleaned = 0;
    assert.throws(() => prepareSandboxedCommand(provider(() => cleaned++), "true", "/w", "/w", config, "/nonexistent/bash"));
    assert.equal(cleaned, 1);
  });

  it("survives sh -c with the command as one intact argument", () => {
    const command = `echo "a b" | tr a b > 'o t'\nprintf '%s' "it's" $HOME \`x\` $(y) \\ ; # end`;
    const { command: wrapped } = prepareSandboxedCommand(provider(() => {}), command, "/w", "/w", config);
    const printed = execFileSync("sh", ["-c", wrapped], { encoding: "utf-8" }).trimEnd().split("\n");
    // printf reuses its format per argument, and the command argument itself contains a newline.
    assert.equal(printed.slice(-2).join("\n"), command);
  });

  it("noop provider refuses to prepare", () => {
    assert.throws(() => providers.none.prepare("/w", "/w", config), /no OS sandbox provider/);
  });
});

describe("tool_call hook", () => {
  function load(overrides: { flags?: Record<string, boolean>; config?: string } = {}) {
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-hook-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const pi = {
      registerFlag() {},
      registerTool() {},
      registerCommand() {},
      getFlag: (name: string) => overrides.flags?.[name] ?? false,
      getSettings: () => ({}),
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    };
    extension(pi as never);
    return {
      async call(toolName: string, input: Record<string, unknown>) {
        const results = [];
        for (const handler of handlers.tool_call) {
          results.push(await handler({ toolName, input }, {}));
        }
        return results.find(Boolean) as { block: true; reason: string } | undefined;
      },
      async start() {
        for (const handler of handlers.session_start) await handler({}, {});
      },
      done() {
        process.env.PI_CODING_AGENT_DIR = previous;
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("leaves bg_run untouched when the sandbox is disabled", async () => {
    const hook = load({ flags: { "no-sandbox": true } });
    await hook.start();
    const input = { command: "echo hi" };
    assert.equal(await hook.call("bg_run", input), undefined);
    assert.deepEqual(input, { command: "echo hi" });
    hook.done();
  });

  it("does not touch tools without an adapter", async () => {
    const hook = load({ flags: { sandbox: true } });
    await hook.start();
    const input = { command: "echo hi" };
    assert.equal(await hook.call("bg_runner", input), undefined);
    assert.deepEqual(input, { command: "echo hi" });
    hook.done();
  });

  it("names the tool when blocking", async () => {
    const hook = load({ flags: { sandbox: true } });
    await hook.start();
    const result = await hook.call("bg_run", { command: " " });
    assert.equal(result?.block, true);
    assert.match(result!.reason, /^pi-sandbox: bg_run blocked \(/);
    hook.done();
  });
});
