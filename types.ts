import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface SandboxConfig {
  /** Directories the agent is allowed to write to. "${WORKSPACE}" expands to the project root. */
  writable: string[];
  /** Paths explicitly denied for writes, even inside writable directories (e.g. .git/hooks). */
  denyWithin: string[];
  /** Allow outbound network access. Default: true. */
  network: boolean;
  /** Force a specific provider: "auto" | "sandbox-exec" | "bubblewrap" | "none". Default: "auto". */
  provider?: SandboxProviderType;
}

export type SandboxProviderType = "auto" | "sandbox-exec" | "bubblewrap" | "none";

export interface SandboxProvider {
  /** Human-readable name for logging. */
  readonly name: string;
  /** Whether this provider is available on the current system. */
  available(): boolean;
  /**
   * Wraps a BashOperations instance with sandbox enforcement.
   * Returns a new BashOperations whose `exec` passes commands through the OS sandbox.
   */
  wrap(inner: BashOperations, cwd: string, config: SandboxConfig): BashOperations;
}

export interface PathResolver {
  /** Resolve config path placeholders like "${WORKSPACE}" to real filesystem paths. */
  resolve(path: string): string;
}
