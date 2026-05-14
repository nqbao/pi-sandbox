import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SandboxConfig } from "./types.ts";

export function stripTrailingSep(p: string): string {
  if (p === "/") return "";
  while (p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}

export function expandHomePath(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

export function resolveToolPath(cwd: string, targetPath: string): string {
  return resolve(cwd, expandHomePath(targetPath));
}

export function isPathAllowed(absolutePath: string, config: SandboxConfig): boolean {
  const normPath = stripTrailingSep(resolve(absolutePath));
  for (const denied of config.denyWithin) {
    const d = stripTrailingSep(resolve(denied));
    if (normPath === d || normPath.startsWith(d + "/")) {
      return false;
    }
  }
  for (const allowed of config.writable) {
    const a = stripTrailingSep(resolve(allowed));
    if (normPath === a || normPath.startsWith(a + "/")) {
      return true;
    }
  }
  return false;
}
