import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPathResolver, loadConfig, getProtectedConfigPaths, getProtectedPiPaths, getRequiredWritablePaths, getProjectConfigPath, resolveEnabled, resolveReadOnly, computeEffectiveDenyRead } from "./config.ts";
import { isPathAllowed, isPathReadable, resolveRealPath } from "./guard.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Tests must never pick up the developer's real ~/.pi/agent/sandbox.json, so every loadConfig
// call here passes an explicit (missing) global config path.
const EMPTY_DIR = mkdtempSync(join(tmpdir(), "pi-sandbox-empty-"));
const NO_GLOBAL_CONFIG = [join(EMPTY_DIR, "sandbox.json")];

function load(workspaceDir = "/workspace", globalConfigPaths: string[] = NO_GLOBAL_CONFIG) {
  return loadConfig(workspaceDir, { globalConfigPaths });
}

after(() => {
  rmSync(EMPTY_DIR, { recursive: true, force: true });
});

describe("resolveEnabled", () => {
  it("defaults to enabled", () => {
    assert.equal(resolveEnabled(undefined), true);
  });

  it("accepts explicit booleans", () => {
    assert.equal(resolveEnabled(true), true);
    assert.equal(resolveEnabled(false), false);
  });
});

describe("resolveReadOnly", () => {
  it("defaults to false", () => {
    assert.equal(resolveReadOnly(undefined), false);
  });

  it("accepts explicit booleans", () => {
    assert.equal(resolveReadOnly(true), true);
    assert.equal(resolveReadOnly(false), false);
  });
});

describe("createPathResolver", () => {
  const resolver = createPathResolver("/workspace");

  it("expands a leading ~ to the home directory", () => {
    assert.equal(resolver.resolve("~/.npmrc"), join(homedir(), ".npmrc"));
    assert.equal(resolver.resolve("~"), homedir());
  });

  it("does not expand ~ in the middle of a path", () => {
    assert.equal(resolver.resolve("a/~/b"), "/workspace/a/~/b");
  });

  it("expands ${AGENT_DIR} to the Pi agent directory", () => {
    assert.equal(resolver.resolve("${AGENT_DIR}/auth.json"), join(getAgentDir(), "auth.json"));
  });
});

describe("loadConfig", () => {  it("always includes required Pi support paths in writable roots", () => {
    const { config, pathResolver } = load();
    const requiredPaths = getRequiredWritablePaths(pathResolver);

    for (const path of requiredPaths) {
      const realPath = resolveRealPath(path);
      assert.equal(
        config.writable.includes(realPath),
        true,
        `expected required writable path ${realPath} to be present`,
      );
    }
  });

  it("always protects Pi sandbox config paths", () => {
    const { config } = load();
    assert.equal(config.enabled, true);
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      const realPath = resolveRealPath(path);
      assert.equal(
        config.denyWithin.includes(realPath),
        true,
        `expected protected config path ${realPath} to be denied`,
      );
    }
  });

  it("keeps protected config paths denied even if parent directories are writable", () => {
    const { config } = load();
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      const realPath = resolveRealPath(path);
      assert.equal(config.denyWithin.includes(realPath), true);
      assert.equal(isPathAllowed(realPath, config), false);
    }
  });

  it("write-protects Pi extension, package, settings, and trust paths", () => {
    const { config } = load();
    const agentDir = getAgentDir();
    const expected = [
      join(agentDir, "extensions", "evil.ts"),
      join(agentDir, "npm", "node_modules", "pkg", "index.js"),
      join(agentDir, "git", "repo", "index.ts"),
      join(agentDir, "settings.json"),
      join(agentDir, "trust.json"),
      join(agentDir, "mcp.json"),
      join(agentDir, "models.json"),
      join(agentDir, "auth.json"),
      "/workspace/.pi/extensions/evil.ts",
      "/workspace/.pi/settings.json",
    ];
    for (const path of expected) {
      assert.equal(isPathAllowed(resolveRealPath(path), config), false, `expected ${path} to be write-protected`);
    }
    // The rest of the agent dir isn't writable by default either; it's mounted read-only.
    const skillsPath = resolveRealPath(join(agentDir, "skills", "x", "SKILL.md"));
    if (!skillsPath.startsWith(resolveRealPath(tmpdir()) + "/")) {
      // When HOME points inside ${TMP} (a test fixture, not a real setup), the agent dir is
      // writable through the TMP root, so only assert the guard for a normal location.
      assert.equal(isPathAllowed(skillsPath, config), false);
    }
    assert.equal(config.writable.includes(resolveRealPath(agentDir)), false);
    assert.deepEqual(config.readOnlyMounts, [resolveRealPath(agentDir)]);
  });

  it("denies reading Pi API keys and common credential files by default", () => {
    const { config } = load();
    const expected = [
      join(getAgentDir(), "auth.json"),
      join(homedir(), ".config", "gh", "hosts.yml"),
      join(homedir(), ".npmrc"),
      join(homedir(), ".docker", "config.json"),
      join(homedir(), ".kube", "config"),
    ];
    for (const path of expected) {
      assert.equal(isPathReadable(resolveRealPath(path), config), false, `expected ${path} to be unreadable`);
    }
  });

  it("lets allowRead opt back into a default-denied credential path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-agent-"));
    const configPath = join(dir, "sandbox.json");
    const previous = process.env.PI_CODING_AGENT_DIR;
    writeFileSync(configPath, JSON.stringify({ allowRead: ["~/.npmrc", "${AGENT_DIR}/auth.json"] }));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const { config } = load("/workspace", [configPath]);
      assert.equal(isPathReadable(resolveRealPath(join(homedir(), ".npmrc")), config), true);
      assert.equal(isPathReadable(resolveRealPath(join(dir, "auth.json")), config), true);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the global config from the agent dir by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-default-global-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify({ network: false }));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const { config, sources } = loadConfig("/workspace");
      assert.equal(config.network, false);
      assert.deepEqual(sources, [join(dir, "sandbox.json")]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls through to the next global config when one fails to parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-broken-global-"));
    const broken = join(dir, "agent", "sandbox.json");
    const valid = join(dir, "agent-fallback", "sandbox.json");
    mkdirSync(dirname(broken), { recursive: true });
    mkdirSync(dirname(valid), { recursive: true });
    writeFileSync(broken, "{ not json");
    writeFileSync(valid, JSON.stringify({ network: false, readOnly: true }));
    try {
      const { config, sources } = load("/workspace", [broken, valid]);
      assert.equal(config.network, false);
      assert.equal(config.readOnly, true);
      assert.deepEqual(sources, [valid]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not report an unparseable global config as a source", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-broken-only-"));
    const broken = join(dir, "sandbox.json");
    writeFileSync(broken, "{ not json");
    try {
      const { config, sources } = load("/workspace", [broken]);
      assert.deepEqual(sources, []);
      assert.equal(config.network, true);
      assert.equal(config.readOnly, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write-protects .git/config by default", () => {
    const { config } = load();
    assert.equal(isPathAllowed(resolveRealPath("/workspace/.git/config"), config), false);
    assert.equal(isPathAllowed(resolveRealPath("/workspace/.git/index"), config), true);
  });

  it("exposes protected files and directories separately", () => {
    const { config } = load();
    const { files, dirs } = getProtectedPiPaths("/workspace");
    for (const path of files) {
      assert.ok(config.protectedFiles?.includes(resolveRealPath(path)), `expected ${path} in protectedFiles`);
    }
    for (const path of dirs) {
      assert.ok(config.protectedDirs?.includes(resolveRealPath(path)), `expected ${path} in protectedDirs`);
    }
  });

  it("defaults denyRead to the resolved DEFAULT_DENY_READ paths", () => {
    const { config } = load();
    assert.equal(config.denyRead.length > 0, true);
    assert.equal(config.allowRead.length, 0);
  });

  it("defaults readOnly to false", () => {
    const { config } = load();
    assert.equal(config.readOnly, false);
  });
});

describe("project-level sandbox.json", () => {
  type FixtureContext = {
    workspace: string;
    agentDir: string;
    loadConfigFor: (options?: { globalConfigPaths?: string[] }) => ReturnType<typeof loadConfig>;
  };

  function withFixtures(files: { global?: unknown; project?: unknown }, run: (ctx: FixtureContext) => void) {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-project-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const write = (path: string, content: unknown) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(content));
    };
    if (files.global !== undefined) write(join(agentDir, "sandbox.json"), files.global);
    if (files.project !== undefined) write(join(workspace, ".pi", "sandbox.json"), files.project);

    // Only the fixture agent dir is searched, so the real ~/.pi/agent is never consulted.
    const globalConfigPaths = [join(agentDir, "sandbox.json")];
    try {
      run({
        workspace,
        agentDir,
        loadConfigFor: (options = {}) => loadConfig(workspace, { globalConfigPaths, ...options }),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("is read from .pi/sandbox.json and reported as a config source", () => {
    withFixtures({ project: { enabled: true } }, ({ workspace, loadConfigFor }) => {
      const { sources, config, warnings } = loadConfigFor();
      const projectPath = getProjectConfigPath(workspace);
      assert.ok(sources.includes(projectPath));
      assert.deepEqual(warnings, []);
      assert.equal(config.enabled, true);
    });
  });

  it("lists global first, then project", () => {
    withFixtures({ global: { network: true }, project: { readOnly: true } }, ({ workspace, agentDir, loadConfigFor }) => {
      const { sources } = loadConfigFor();
      assert.deepEqual(sources, [join(agentDir, "sandbox.json"), getProjectConfigPath(workspace)]);
    });
  });

  it("can tighten switches (enabled=true, readOnly=true, network=false)", () => {
    withFixtures(
      { global: { enabled: false, network: true }, project: { enabled: true, readOnly: true, network: false } },
      ({ loadConfigFor }) => {
        const { config, warnings } = loadConfigFor();
        assert.equal(config.enabled, true);
        assert.equal(config.readOnly, true);
        assert.equal(config.network, false);
        assert.deepEqual(warnings, []);
      },
    );
  });

  it("cannot loosen switches (enabled=false, readOnly=false, network=true)", () => {
    withFixtures(
      { global: { enabled: true, readOnly: true, network: false }, project: { enabled: false, readOnly: false, network: true } },
      ({ loadConfigFor }) => {
        const { config, warnings } = loadConfigFor();
        assert.equal(config.enabled, true);
        assert.equal(config.readOnly, true);
        assert.equal(config.network, false);
        assert.equal(warnings.length, 3);
        for (const warning of warnings) assert.match(warning, /can only tighten the policy/);
      },
    );
  });

  it("cannot disable a sandbox that is on by default", () => {
    withFixtures({ project: { enabled: false } }, ({ loadConfigFor }) => {
      assert.equal(loadConfigFor().config.enabled, true);
    });
  });

  it("adds denyRead and denyWithin entries to the global ones", () => {
    withFixtures(
      {
        global: { denyRead: ["~/secrets-a"], denyWithin: ["${WORKSPACE}/hooks"] },
        project: { denyRead: ["~/secrets-b"], denyWithin: ["${WORKSPACE}/scripts"] },
      },
      ({ workspace, loadConfigFor }) => {
        const { config } = loadConfigFor();
        assert.equal(isPathReadable(resolveRealPath(join(homedir(), "secrets-a")), config), false);
        assert.equal(isPathReadable(resolveRealPath(join(homedir(), "secrets-b")), config), false);
        assert.equal(isPathAllowed(resolveRealPath(join(workspace, "hooks", "pre-commit")), config), false);
        assert.equal(isPathAllowed(resolveRealPath(join(workspace, "scripts", "build.sh")), config), false);
      },
    );
  });

  it("keeps the default denyWithin entries when the global config leaves it unset", () => {
    withFixtures({ global: {}, project: { denyWithin: ["${WORKSPACE}/generated"] } }, ({ workspace, loadConfigFor }) => {
      const { config } = loadConfigFor();
      assert.equal(isPathAllowed(resolveRealPath(join(workspace, "generated", "out.js")), config), false);
      assert.equal(isPathAllowed(resolveRealPath(join(workspace, ".git", "hooks", "pre-commit")), config), false);
      assert.equal(isPathAllowed(resolveRealPath(join(workspace, ".git", "config")), config), false);
    });
  });

  it("ignores allowRead, writable, provider, and allowBackgroundProcesses", () => {
    withFixtures(
      {
        global: { network: false },
        project: {
          allowRead: ["~/.npmrc"],
          writable: ["/"],
          provider: "none",
          allowBackgroundProcesses: true,
        },
      },
      ({ loadConfigFor }) => {
        const { config, warnings } = loadConfigFor();
        assert.equal(warnings.length, 4);
        for (const field of ["allowRead", "writable", "provider", "allowBackgroundProcesses"]) {
          assert.ok(warnings.some((w) => w.includes(`Ignoring ${field}`)), `expected a warning for ${field}`);
        }
        // Default-denied credentials stay denied, and writable roots are unchanged.
        assert.equal(isPathReadable(resolveRealPath(join(homedir(), ".npmrc")), config), false);
        assert.equal(config.writable.includes(resolveRealPath("/")), false);
        assert.equal(config.provider, "auto");
        assert.equal(config.allowBackgroundProcesses, false);
      },
    );
  });

  it("lets the project turn allowGpu on or off", () => {
    withFixtures({ global: {}, project: { allowGpu: true } }, ({ loadConfigFor }) => {
      const { config, warnings } = loadConfigFor();
      assert.equal(config.allowGpu, true);
      assert.deepEqual(warnings, []);
    });
    withFixtures({ global: { allowGpu: true }, project: { allowGpu: false } }, ({ loadConfigFor }) => {
      assert.equal(loadConfigFor().config.allowGpu, false);
    });
  });

  it("ignores a non-boolean project allowGpu", () => {
    withFixtures({ global: { allowGpu: true }, project: { allowGpu: "no" } }, ({ loadConfigFor }) => {
      const { config, warnings } = loadConfigFor();
      assert.equal(config.allowGpu, true);
      assert.ok(warnings.some((w) => w.includes("Ignoring allowGpu")));
    });
    withFixtures({ global: {}, project: { allowGpu: "yes" } }, ({ loadConfigFor }) => {
      assert.equal(loadConfigFor().config.allowGpu, false);
    });
  });

  it("keeps allowGpu from the global config and off by default", () => {
    withFixtures({ global: { allowGpu: true }, project: {} }, ({ loadConfigFor }) => {
      assert.equal(loadConfigFor().config.allowGpu, true);
    });
    withFixtures({ global: {}, project: {} }, ({ loadConfigFor }) => {
      assert.equal(loadConfigFor().config.allowGpu, false);
    });
  });

  it("write-protects the project config file", () => {
    withFixtures({ project: {} }, ({ workspace, loadConfigFor }) => {
      const { config } = loadConfigFor();
      const projectPath = resolveRealPath(getProjectConfigPath(workspace));
      assert.equal(isPathAllowed(projectPath, config), false);
      assert.ok(config.protectedFiles?.includes(projectPath));
    });
  });

  it("ignores an unparseable project config", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-badjson-"));
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "sandbox.json"), "{ not json");
    try {
      const { config, sources } = load(workspace);
      assert.equal(config.enabled, true);
      assert.equal(config.readOnly, false);
      assert.equal(sources.includes(getProjectConfigPath(workspace)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeEffectiveDenyRead", () => {
  const defaults = ["/home/user/.ssh", "/home/user/.aws", "/etc/shadow"];

  it("returns all defaults when no allowRead or denyRead", () => {
    const { effectiveDenyRead, effectiveAllowRead, conflicts, inconsistentAllow } = computeEffectiveDenyRead([], [], defaults);
    assert.deepEqual(effectiveDenyRead, defaults);
    assert.deepEqual(effectiveAllowRead, []);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(inconsistentAllow, []);
  });

  it("removes exact default path when covered by allowRead", () => {
    const { effectiveDenyRead, effectiveAllowRead, inconsistentAllow } = computeEffectiveDenyRead([], ["/home/user/.ssh"], defaults);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), false);
    assert.equal(effectiveDenyRead.includes("/home/user/.aws"), true);
    assert.equal(effectiveDenyRead.includes("/etc/shadow"), true);
    assert.deepEqual(effectiveAllowRead, ["/home/user/.ssh"]);
    assert.deepEqual(inconsistentAllow, []);
  });

  it("removes default child paths when parent is in allowRead", () => {
    const defaultsWithChild = ["/home/user/.ssh", "/home/user/.ssh/id_rsa"];
    const { effectiveDenyRead, effectiveAllowRead, inconsistentAllow } = computeEffectiveDenyRead([], ["/home/user/.ssh"], defaultsWithChild);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), false);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh/id_rsa"), false);
    assert.deepEqual(effectiveAllowRead, ["/home/user/.ssh"]);
    assert.deepEqual(inconsistentAllow, []);
  });

  it("merges user denyRead with filtered defaults", () => {
    const { effectiveDenyRead } = computeEffectiveDenyRead(["/home/user/.config"], [], defaults);
    assert.equal(effectiveDenyRead.includes("/home/user/.config"), true);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), true);
  });

  it("detects conflict when same path is in allowRead and denyRead", () => {
    const { effectiveDenyRead, effectiveAllowRead, conflicts } = computeEffectiveDenyRead(
      ["/home/user/.ssh"],
      ["/home/user/.ssh"],
      defaults,
    );
    assert.deepEqual(conflicts, ["/home/user/.ssh"]);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), true);
    assert.equal(effectiveAllowRead.includes("/home/user/.ssh"), false);
  });

  it("no conflict when allowRead and denyRead have different paths", () => {
    const { conflicts } = computeEffectiveDenyRead(["/home/user/.aws"], ["/home/user/.ssh"], defaults);
    assert.deepEqual(conflicts, []);
  });

  it("detects conflict when denyRead is a parent of allowRead (allowRead is silently covered)", () => {
    const { effectiveDenyRead, effectiveAllowRead, conflicts } = computeEffectiveDenyRead(
      ["/home/user"],
      ["/home/user/.ssh"],
      [],
    );
    assert.deepEqual(conflicts, ["/home/user/.ssh"]);
    assert.equal(effectiveDenyRead.includes("/home/user"), true);
    assert.equal(effectiveAllowRead.includes("/home/user/.ssh"), false);
  });

  it("no conflict when allowRead is a parent of denyRead (intentional: allow broad, deny specific)", () => {
    const { effectiveAllowRead, conflicts, inconsistentAllow } = computeEffectiveDenyRead(["/home/user/.ssh"], ["/home/user"], []);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(inconsistentAllow, []);
    assert.deepEqual(effectiveAllowRead, ["/home/user"]);
  });

  it("detects and removes allowRead entry that is a child of effectiveDenyRead", () => {
    const { effectiveAllowRead, inconsistentAllow } = computeEffectiveDenyRead(
      [],
      ["/home/user/.ssh/config"],
      ["/home/user/.ssh"],
    );
    assert.deepEqual(inconsistentAllow, ["/home/user/.ssh/config"]);
    assert.deepEqual(effectiveAllowRead, []);
  });
});
