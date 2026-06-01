import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig, PathResolver, SandboxProviderType } from "./types.ts";
export { isPathAllowed } from "./guard.ts";
import { resolveRealPath, stripTrailingSep } from "./guard.ts";

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
    TMP: tmpdir(),
    TMPDIR: tmpdir(),
  };

  return {
    resolve(path: string): string {
      let resolved = path;
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
  "/etc/shadow",
  "/etc/sudoers",
];
const DEFAULT_WRITABLE = ["${WORKSPACE}", "${TMP}"];
const DEFAULT_DENY_WITHIN = ["${WORKSPACE}/.git/hooks"];

export function getProtectedConfigPaths(): string[] {
  return CONFIG_SEARCH_PATHS.map((getPath) => resolve(getPath()));
}

export function getRequiredWritablePaths(pathResolver: PathResolver): string[] {
  return [
    resolve(pathResolver.resolve("${WORKSPACE}")),
    resolve(pathResolver.resolve("${TMP}")),
    resolve(getAgentDir()),
  ];
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

  return {
    config: {
      enabled: resolveEnabled(raw.enabled),
      readOnly: resolveReadOnly(raw.readOnly),
      allowRead,
      denyRead,
      writable: mergeWritable(raw.writable, pathResolver),
      denyWithin: mergeDenyWithin(raw.denyWithin, pathResolver),
      network: raw.network ?? true,
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

export function mergeWritable(raw: unknown, resolver: PathResolver): string[] {
  const userPaths = Array.isArray(raw)
    ? raw.map((p) => resolveRealPath(resolver.resolve(String(p))))
    : [];
  const defaults = DEFAULT_WRITABLE.map((p) => resolveRealPath(resolver.resolve(p)));
  const required = getRequiredWritablePaths(resolver).map((p) => resolveRealPath(p));
  return [...new Set([...userPaths, ...defaults, ...required])];
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

  // Exact-match conflicts only: child-of-deny cases are handled by inconsistentAllow below,
  // which emits the correct "inside a denied directory" diagnostic.
  const conflicts = userAllowRead.filter((a) => {
    const na = stripTrailingSep(a);
    return userDenyRead.some((d) => na === stripTrailingSep(d));
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
  const resolvedDefaults = DEFAULT_DENY_READ.map((p) => resolveRealPath(resolver.resolve(p)));

  const { effectiveDenyRead, effectiveAllowRead, conflicts, inconsistentAllow } = computeEffectiveDenyRead(userDenyRead, userAllowRead, resolvedDefaults);

  for (const p of conflicts) {
    console.warn(`[pi-sandbox] Path "${p}" is in both allowRead and denyRead — forcing deny`);
  }
  for (const p of inconsistentAllow) {
    console.warn(`[pi-sandbox] allowRead "${p}" is inside a denied directory — specify the parent directory to allow the whole subtree`);
  }

  return { denyRead: effectiveDenyRead, allowRead: effectiveAllowRead };
}

function mergeDenyWithin(raw: unknown, resolver: PathResolver): string[] {
  const resolved = resolveList(raw, DEFAULT_DENY_WITHIN, resolver);
  const protectedPaths = getProtectedConfigPaths().map((p) => resolveRealPath(p));
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
