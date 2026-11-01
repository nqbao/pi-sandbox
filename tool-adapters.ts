// Adapters for tools from other extensions that run shell commands themselves, outside Pi's
// bash tool. To cover another such tool, add an entry to `toolAdapters`: the tool_call hook in
// index.ts looks tools up by exact name and owns everything that isn't specific to the tool.

/** Returns a shell command that runs `command` in the sandbox, started from `cwd`. */
export type SandboxCommand = (command: string, cwd: string) => string;

export interface ToolAdapter {
  /** Rewrites the tool's input in place. Returns a reason to block the call instead. Throwing also blocks it. */
  rewrite(input: Record<string, unknown>, sandbox: SandboxCommand): string | void;
}

// pi-bg-run labels a job from its command, which would otherwise be the sandbox wrapper.
export function bgRunLabel(command: string): string {
  const text = command.trim().replace(/\s+/g, " ");
  return text.length > 50 ? `${text.slice(0, 47)}...` : text;
}

const bgRun: ToolAdapter = {
  rewrite(input, sandbox) {
    const { command } = input;
    // An empty command has to be caught here: once wrapped it's no longer empty to pi-bg-run.
    if (typeof command !== "string" || command.trim() === "") {
      return "command must be a non-empty string";
    }
    // pi-bg-run spawns without a cwd, so jobs start in Pi's working directory.
    const sandboxed = sandbox(command, process.cwd());
    if (!input.label) {
      input.label = bgRunLabel(command);
    }
    input.command = sandboxed;
    return undefined;
  },
};

export const toolAdapters: ReadonlyMap<string, ToolAdapter> = new Map([["bg_run", bgRun]]);
