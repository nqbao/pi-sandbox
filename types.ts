import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface SandboxConfig {
  /** Global sandbox switch. When false, bash and file-tool guards run unsandboxed. Default: true. */
  enabled: boolean;
  /** When true, block all filesystem writes regardless of writable roots. */
  readOnly?: boolean;
  /** Paths explicitly allowed for reads, overriding defaultDenyRead entries. */
  allowRead?: string[];
  /** Paths explicitly denied for reads by built-in read-only file tools. */
  denyRead: string[];
  /** Directories the agent is allowed to write to. "${WORKSPACE}" expands to the project root. */
  writable: string[];
  /** Paths explicitly denied for writes, even inside writable directories (e.g. .git/hooks). */
  denyWithin: string[];
  /** Pi config files that are always write-protected (also included in denyWithin). */
  protectedFiles?: string[];
  /** Pi code/config directories that are always write-protected (also included in denyWithin). */
  protectedDirs?: string[];
  /** Paths mounted read-only in the Linux sandbox (the Pi agent dir). Writable roots take precedence. */
  readOnlyMounts?: string[];
  /** Allow outbound network access. Default: true. */
  network: boolean;
  /**
   * Linux only: let background jobs (`cmd &`) keep running after the command returns, by not
   * giving each command its own PID namespace. Sandboxed commands can then see and signal
   * host processes. Default: false.
   */
  allowBackgroundProcesses?: boolean;
  /**
   * macOS only: let sandboxed commands use the GPU through Metal (e.g. PyTorch MPS). Opens GPU
   * driver interfaces to sandboxed code, which is a large kernel attack surface. Default: false.
   */
  allowGpu?: boolean;
  /** Force a specific provider: "auto" | "sandbox-exec" | "bubblewrap" | "none". Default: "auto". */
  provider?: SandboxProviderType;
}

export type SandboxProviderType = "auto" | "sandbox-exec" | "bubblewrap" | "none";

export interface SandboxInvocation {
  /** The sandbox binary. */
  executable: string;
  /** Arguments to the sandbox binary, up to but excluding the `--` before the shell. */
  args: string[];
  /** Releases temporary files the sandbox mounts. Absent when there are none. */
  cleanup?: () => void;
}

export interface SandboxProvider {
  /** Human-readable name for logging. */
  readonly name: string;
  /** Whether this provider is available on the current system. */
  available(): boolean;
  /** Builds the sandbox invocation for a command run from `cwd`. Throws if it can't be prepared. */
  prepare(cwd: string, workspaceDir: string, config: SandboxConfig): SandboxInvocation;
  /**
   * Wraps a BashOperations instance with sandbox enforcement.
   * Returns a new BashOperations whose `exec` passes commands through the OS sandbox.
   * `shellPath` is Pi's shellPath setting, if set; the sandboxed command runs in that shell.
   */
  wrap(inner: BashOperations, cwd: string, config: SandboxConfig, shellPath?: string): BashOperations;
}

export interface PathResolver {
  /** Resolve config path placeholders like "${WORKSPACE}" to real filesystem paths. */
  resolve(path: string): string;
}
