import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig, PathResolver, SandboxProviderType } from "./types.ts";
export { isPathAllowed } from "./guard.ts";
import { resolveRealPath } from "./guard.ts";

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

const DEFAULT_DENY_READ: string[] = [];
const DEFAULT_WRITABLE = ["${WORKSPACE}", "${TMP}"];
const DEFAULT_DENY_WITHIN = ["${WORKSPACE}/.git/hooks"];

export function getProtectedConfigPaths(): string[] {
  return CONFIG_SEARCH_PATHS.map((getPath) => resolve(getPath()));
}

export function getRequiredWritablePaths(pathResolver: PathResolver): string[] {
  return [
    resolve(pathResolver.resolve("${WORKSPACE}")),
    resolve(pathResolver.resolve("${TMP}")),
    resolve(pathResolver.resolve("${HOME}/.pi")),
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

  return {
    config: {
      enabled: resolveEnabled(raw.enabled),
      readOnly: resolveReadOnly(raw.readOnly),
      denyRead: mergeDenyRead(raw.denyRead, pathResolver),
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

function mergeWritable(raw: unknown, resolver: PathResolver): string[] {
  const resolved = resolveList(raw, DEFAULT_WRITABLE, resolver);
  const required = getRequiredWritablePaths(resolver).map((p) => resolveRealPath(p));
  return [...new Set([...resolved, ...required])];
}

function mergeDenyRead(raw: unknown, resolver: PathResolver): string[] {
  const resolved = resolveList(raw, [], resolver);
  // DEFAULT_DENY_READ is empty; paths are already resolved by resolveList
  return [...new Set(resolved)];
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
