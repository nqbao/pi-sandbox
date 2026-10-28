import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig, PathResolver, SandboxProviderType } from "./types.ts";
export { isPathAllowed } from "./guard.ts";
import { expandHomePath, resolveRealPath, stripTrailingSep } from "./guard.ts";

const VALID_PROVIDERS = new Set<SandboxProviderType>(["auto", "sandbox-exec", "bubblewrap", "none"]);

const CONFIG_FILE = "sandbox.json";
const CONFIG_SEARCH_PATHS = [
  () => `${getAgentDir()}/${CONFIG_FILE}`,
  () => `${homedir()}/.pi/agent/${CONFIG_FILE}`,
];

export function createPathResolver(workspaceDir: string): PathResolver {
  const vars: Record<string, string> = {
    WORKSPACE: workspaceDir,
    HOME: homedir(),
    AGENT_DIR: getAgentDir(),
    TMP: tmpdir(),
    TMPDIR: tmpdir(),
  };

  return {
    resolve(path: string): string {
      let resolved = expandHomePath(path);
      for (const [key, value] of Object.entries(vars)) {
        resolved = resolved.replaceAll(`\${${key}}`, value);
      }
      if (!isAbsolute(resolved)) {
        resolved = resolve(workspaceDir, resolved);
      }
      return resolved;
    },
  };
}

const DEFAULT_DENY_READ: string[] = [
  "${HOME}/.ssh",
  "${HOME}/.aws",
  "${HOME}/.gnupg",
  "${HOME}/.config/gcloud",
  "${HOME}/.netrc",
  "${HOME}/.git-credentials",
  // Developer tool and cloud CLI tokens
  "${HOME}/.config/gh",
  "${HOME}/.npmrc",
  "${HOME}/.pypirc",
  "${HOME}/.cargo/credentials.toml",
  "${HOME}/.docker/config.json",
  "${HOME}/.kube",
  "${HOME}/.azure",
  "${HOME}/.terraform.d/credentials.tfrc.json",
  "${HOME}/.vault-token",
  // Password managers
  "${HOME}/.password-store",
  "${HOME}/.config/op",
  // Browser profiles and cookies (macOS)
  "${HOME}/Library/Application Support/Google/Chrome",
  "${HOME}/Library/Application Support/Firefox",
  "${HOME}/Library/Cookies",
  "/etc/shadow",
  "/etc/sudoers",
];
// Pi's API keys, relative to the agent dir.
const DEFAULT_DENY_READ_AGENT_FILES = ["auth.json"];
const DEFAULT_WRITABLE = ["${WORKSPACE}", "${TMP}"];
// .git/config can run commands outside the sandbox (core.hooksPath, core.fsmonitor, core.sshCommand).
const DEFAULT_DENY_WITHIN = ["${WORKSPACE}/.git/hooks", "${WORKSPACE}/.git/config"];

export function getProtectedConfigPaths(): string[] {
  return CONFIG_SEARCH_PATHS.map((getPath) => resolve(getPath()));
}

// Files and directories Pi loads code, credentials, or trust decisions from. The agent must
// not be able to write these, or it could plant something that runs unsandboxed on next start.
const PROTECTED_AGENT_FILES = ["settings.json", "trust.json", "mcp.json", "models.json", "auth.json"];
const PROTECTED_AGENT_DIRS = ["extensions", "npm", "git"];
const PROJECT_CONFIG_DIR = ".pi";

export function getProtectedPiPaths(workspaceDir: string): { files: string[]; dirs: string[] } {
  const agentDir = resolve(getAgentDir());
  return {
    files: [
      ...getProtectedConfigPaths(),
      ...PROTECTED_AGENT_FILES.map((name) => resolve(agentDir, name)),
    ],
    dirs: [
      ...PROTECTED_AGENT_DIRS.map((name) => resolve(agentDir, name)),
      // Project-local extensions, packages, settings, and prompts all live here.
      resolve(workspaceDir, PROJECT_CONFIG_DIR),
    ],
  };
}

export function getRequiredWritablePaths(pathResolver: PathResolver): string[] {
  return [
    resolve(pathResolver.resolve("${WORKSPACE}")),
    resolve(pathResolver.resolve("${TMP}")),
  ];
}

// Visible to sandboxed commands (e.g. skill scripts) but never writable unless sandbox.json says so.
export function getReadOnlyMounts(): string[] {
  return [resolve(getAgentDir())];
}

export function loadConfig(workspaceDir: string): { config: SandboxConfig; pathResolver: PathResolver } {
  const pathResolver = createPathResolver(workspaceDir);

  let raw: Partial<SandboxConfig> = {};

  for (const getPath of CONFIG_SEARCH_PATHS) {
    const p = getPath();
    if (existsSync(p)) {
      try {
        raw = JSON.parse(readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
        break;
      } catch {
        console.warn(`[pi-sandbox] Failed to parse ${p}, falling back to defaults`);
      }
    }
  }

  const { denyRead, allowRead } = mergeDenyRead(raw.denyRead, raw.allowRead, pathResolver);
  const protectedPaths = getProtectedPiPaths(workspaceDir);
  const protectedFiles = resolveUnique(protectedPaths.files);
  const protectedDirs = resolveUnique(protectedPaths.dirs);

  return {
    config: {
      enabled: resolveEnabled(raw.enabled),
      readOnly: resolveReadOnly(raw.readOnly),
      allowRead,
      denyRead,
      writable: mergeWritable(raw.writable, pathResolver),
      denyWithin: mergeDenyWithin(raw.denyWithin, pathResolver, [...protectedFiles, ...protectedDirs]),
      protectedFiles,
      protectedDirs,
      readOnlyMounts: resolveUnique(getReadOnlyMounts()),
      network: raw.network ?? true,
      allowBackgroundProcesses: raw.allowBackgroundProcesses === true,
      provider: resolveProvider(raw.provider),
    },
    pathResolver,
  };
}

function resolveList(raw: unknown, fallback: string[], resolver: PathResolver): string[] {
  if (Array.isArray(raw)) {
    return raw.map((p) => resolveRealPath(resolver.resolve(String(p))));
  }
  return fallback.map((p) => resolveRealPath(resolver.resolve(p)));
}

function mergeWritable(raw: unknown, resolver: PathResolver): string[] {
  const resolved = resolveList(raw, DEFAULT_WRITABLE, resolver);
  const required = getRequiredWritablePaths(resolver).map((p) => resolveRealPath(p));
  return [...new Set([...resolved, ...required])];
}

export function computeEffectiveDenyRead(
  userDenyRead: string[],
  userAllowRead: string[],
  resolvedDefaults: string[],
): { effectiveDenyRead: string[]; effectiveAllowRead: string[]; conflicts: string[]; inconsistentAllow: string[] } {
  const filteredDefaults = resolvedDefaults.filter(
    (d) => !userAllowRead.some((a) => {
      const na = stripTrailingSep(a);
      const nd = stripTrailingSep(d);
      return nd === na || nd.startsWith(na + "/");
    }),
  );

  const conflicts = userAllowRead.filter((a) => {
    const na = stripTrailingSep(a);
    return userDenyRead.some((d) => {
      const nd = stripTrailingSep(d);
      return na === nd || na.startsWith(nd + "/");
    });
  });

  const conflictSet = new Set(conflicts);
  const effectiveDenyRead = [...new Set([...filteredDefaults, ...userDenyRead])];

  // Detect allowRead entries that are children of effectiveDenyRead — these cannot be
  // consistently enforced across OS-level sandbox providers, which operate on whole directories.
  const inconsistentAllow: string[] = [];
  const effectiveAllowRead = userAllowRead.filter((a) => {
    if (conflictSet.has(a)) return false;
    const na = stripTrailingSep(a);
    const parentDeny = effectiveDenyRead.find((d) => {
      const nd = stripTrailingSep(d);
      return na.startsWith(nd + "/");
    });
    if (parentDeny) {
      inconsistentAllow.push(a);
      return false;
    }
    return true;
  });

  return { effectiveDenyRead, effectiveAllowRead, conflicts, inconsistentAllow };
}

function mergeDenyRead(
  rawDeny: unknown,
  rawAllow: unknown,
  resolver: PathResolver,
): { denyRead: string[]; allowRead: string[] } {
  const userDenyRead = resolveList(rawDeny, [], resolver);
  const userAllowRead = resolveList(rawAllow, [], resolver);
  const resolvedDefaults = [
    ...DEFAULT_DENY_READ.map((p) => resolver.resolve(p)),
    ...DEFAULT_DENY_READ_AGENT_FILES.map((name) => resolve(getAgentDir(), name)),
  ].map((p) => resolveRealPath(p));

  const { effectiveDenyRead, effectiveAllowRead, conflicts, inconsistentAllow } = computeEffectiveDenyRead(userDenyRead, userAllowRead, resolvedDefaults);

  for (const p of conflicts) {
    console.warn(`[pi-sandbox] Path "${p}" is in both allowRead and denyRead — forcing deny`);
  }
  for (const p of inconsistentAllow) {
    console.warn(`[pi-sandbox] allowRead "${p}" is inside a denied directory — specify the parent directory to allow the whole subtree`);
  }

  return { denyRead: effectiveDenyRead, allowRead: effectiveAllowRead };
}

function resolveUnique(paths: string[]): string[] {
  return [...new Set(paths.map((p) => resolveRealPath(p)))];
}

function mergeDenyWithin(raw: unknown, resolver: PathResolver, protectedPaths: string[]): string[] {
  const resolved = resolveList(raw, DEFAULT_DENY_WITHIN, resolver);
  return [...new Set([...resolved, ...protectedPaths])];
}

// Off unless sandbox.json sets enabled: true or Pi is started with --sandbox.
export function resolveEnabled(raw: unknown): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (raw !== undefined) {
    console.warn(`[pi-sandbox] Invalid enabled value "${String(raw)}", falling back to false`);
  }
  return false;
}

export function resolveReadOnly(raw: unknown): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (raw !== undefined) {
    console.warn(`[pi-sandbox] Invalid readOnly value "${String(raw)}", falling back to false`);
  }
  return false;
}

function resolveProvider(raw: unknown): SandboxProviderType {
  if (typeof raw === "string" && (VALID_PROVIDERS as Set<string>).has(raw)) {
    return raw as SandboxProviderType;
  }
  if (raw !== undefined) {
    console.warn(`[pi-sandbox] Invalid provider "${String(raw)}", falling back to "auto"`);
  }
  return "auto";
}
