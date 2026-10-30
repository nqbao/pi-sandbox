import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig, PathResolver, SandboxProviderType } from "./types.ts";
export { isPathAllowed } from "./guard.ts";
import { expandHomePath, resolveRealPath, stripTrailingSep } from "./guard.ts";

const VALID_PROVIDERS = new Set<SandboxProviderType>(["auto", "sandbox-exec", "bubblewrap", "none"]);

const CONFIG_FILE = "sandbox.json";
const PROJECT_CONFIG_DIR = ".pi";
const GLOBAL_CONFIG_SEARCH_PATHS = [
  () => `${getAgentDir()}/${CONFIG_FILE}`,
  () => `${homedir()}/.pi/agent/${CONFIG_FILE}`,
];

// Project-local policy. It comes from the repository, so apart from allowGpu it can only tighten
// the global config.
const IGNORED_PROJECT_FIELDS = ["allowRead", "writable", "provider", "allowBackgroundProcesses"];

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
  return GLOBAL_CONFIG_SEARCH_PATHS.map((getPath) => resolve(getPath()));
}

export function getProjectConfigPath(workspaceDir: string): string {
  return resolve(workspaceDir, PROJECT_CONFIG_DIR, CONFIG_FILE);
}

// Files and directories Pi loads code, credentials, or trust decisions from. The agent must
// not be able to write these, or it could plant something that runs unsandboxed on next start.
const PROTECTED_AGENT_FILES = ["settings.json", "trust.json", "mcp.json", "models.json", "auth.json"];
const PROTECTED_AGENT_DIRS = ["extensions", "npm", "git"];

export function getProtectedPiPaths(workspaceDir: string): { files: string[]; dirs: string[] } {
  const agentDir = resolve(getAgentDir());
  return {
    files: [
      ...getProtectedConfigPaths(),
      getProjectConfigPath(workspaceDir),
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

export interface ConfigLoadResult {
  config: SandboxConfig;
  pathResolver: PathResolver;
  /** Config files that were read, global first, then project. */
  sources: string[];
  warnings: string[];
}

/** Reads a config file and reports whether it exists and parses. */
function readConfigFile(path: string): { raw: Partial<SandboxConfig>; status: "missing" | "ok" | "invalid" } {
  if (!existsSync(path)) {
    return { raw: {}, status: "missing" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("expected a JSON object");
    }
    return { raw: parsed as Partial<SandboxConfig>, status: "ok" };
  } catch {
    console.warn(`[pi-sandbox] Failed to parse ${path}, ignoring it`);
    return { raw: {}, status: "invalid" };
  }
}

/**
 * Uses the first global config that parses. A broken file falls through to the next path, so a
 * leftover sandbox.json in the agent dir can't silently replace `~/.pi/agent/sandbox.json`.
 */
function readGlobalConfig(paths: string[]): { raw: Partial<SandboxConfig>; sources: string[] } {
  for (const path of paths) {
    const result = readConfigFile(path);
    if (result.status === "ok") {
      return { raw: result.raw, sources: [path] };
    }
  }
  return { raw: {}, sources: [] };
}

/**
 * Layers a project config over the global one. A project file ships with the repository, so
 * it may only tighten a policy: it can block more, never less. allowGpu is the one exception,
 * so GPU workloads can opt in per repository.
 */
export function mergeProjectConfig(
  globalRaw: Partial<SandboxConfig>,
  projectRaw: Partial<SandboxConfig>,
  projectPath: string,
  globalPath: string | undefined,
): { raw: Partial<SandboxConfig>; warnings: string[] } {
  const raw: Partial<SandboxConfig> = { ...globalRaw };
  const warnings: string[] = [];
  const hint = `project-level sandbox.json can only tighten the policy; set it in ${globalPath ?? "the global sandbox.json"} instead`;

  // Tightening switches.
  if (projectRaw.enabled === true) {
    raw.enabled = true;
  } else if (projectRaw.enabled !== undefined) {
    warnings.push(`[pi-sandbox] Ignoring enabled=${JSON.stringify(projectRaw.enabled)} in ${projectPath}: ${hint}`);
  }
  if (projectRaw.readOnly === true) {
    raw.readOnly = true;
  } else if (projectRaw.readOnly !== undefined) {
    warnings.push(`[pi-sandbox] Ignoring readOnly=${JSON.stringify(projectRaw.readOnly)} in ${projectPath}: ${hint}`);
  }
  if (projectRaw.network === false) {
    raw.network = false;
  } else if (projectRaw.network !== undefined) {
    warnings.push(`[pi-sandbox] Ignoring network=${JSON.stringify(projectRaw.network)} in ${projectPath}: ${hint}`);
  }

  if (typeof projectRaw.allowGpu === "boolean") {
    raw.allowGpu = projectRaw.allowGpu;
  } else if (projectRaw.allowGpu !== undefined) {
    warnings.push(`[pi-sandbox] Ignoring allowGpu=${JSON.stringify(projectRaw.allowGpu)} in ${projectPath}: expected a boolean`);
  }

  // Deny lists are additive, so a project can always block more paths. When the global
  // config leaves a list unset, extend its defaults so the project can't drop them.
  for (const [field, base] of [
    ["denyRead", globalRaw.denyRead],
    ["denyWithin", Array.isArray(globalRaw.denyWithin) ? globalRaw.denyWithin : DEFAULT_DENY_WITHIN],
  ] as const) {
    const extra = projectRaw[field];
    if (extra === undefined) {
      continue;
    }
    if (!Array.isArray(extra)) {
      warnings.push(`[pi-sandbox] Ignoring ${field} in ${projectPath}: expected an array of paths`);
      continue;
    }
    raw[field] = [...(Array.isArray(base) ? base : []), ...extra];
  }

  for (const field of IGNORED_PROJECT_FIELDS) {
    if (projectRaw[field as keyof SandboxConfig] === undefined) {
      continue;
    }
    warnings.push(`[pi-sandbox] Ignoring ${field} in ${projectPath}: ${hint}`);
  }

  for (const warning of warnings) {
    console.warn(warning);
  }

  return { raw, warnings };
}

export interface LoadConfigOptions {
  /**
   * Global config files to try in order; the first that parses wins. Defaults to
   * `$(pi agent dir)/sandbox.json`, then `~/.pi/agent/sandbox.json`.
   */
  globalConfigPaths?: string[];
}

export function loadConfig(workspaceDir: string, options: LoadConfigOptions = {}): ConfigLoadResult {
  const pathResolver = createPathResolver(workspaceDir);

  const global = readGlobalConfig(options.globalConfigPaths ?? getProtectedConfigPaths());
  const projectPath = getProjectConfigPath(workspaceDir);
  const project = readConfigFile(projectPath);
  const sources = [...global.sources];
  if (project.status === "ok") {
    sources.push(projectPath);
  }
  const { raw, warnings } = mergeProjectConfig(global.raw, project.raw, projectPath, global.sources[0]);

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
      allowGpu: raw.allowGpu === true,
      provider: resolveProvider(raw.provider),
    },
    pathResolver,
    sources,
    warnings,
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

export function resolveEnabled(raw: unknown): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (raw !== undefined) {
    console.warn(`[pi-sandbox] Invalid enabled value "${String(raw)}", falling back to true`);
  }
  return true;
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
