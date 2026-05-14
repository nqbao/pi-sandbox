import {
  type ExtensionAPI,
  createBashTool,
  createLocalBashOperations,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { resolve, dirname, basename, join } from "node:path";
import { realpathSync, readFileSync } from "node:fs";
import { loadConfig, isPathAllowed } from "./config";
import { selectProvider } from "./providers";

let _version = "unknown";
try {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
  _version = pkg.version ?? "unknown";
} catch {
  // package.json not accessible (e.g., bundled deployment)
}

export default function (pi: ExtensionAPI) {
  const workspaceDir = process.cwd();
  const { config } = loadConfig(workspaceDir);
  const provider = selectProvider(config.provider);

  if (config.provider && config.provider !== "auto" && !provider.available()) {
    console.warn(
      `[pi-sandbox] Forced provider "${config.provider}" is not available on this system. ` +
        `Falling back to automatic detection. Set provider to "auto" to suppress this warning.`,
    );
  }

  const activeProvider = provider.available() ? provider : selectProvider("auto");

  if (activeProvider.name === "none") {
    console.warn(
      "[pi-sandbox] No OS sandbox provider available (sandbox-exec requires macOS, bwrap requires Linux). " +
        "Commands will run unsandboxed. Install bubblewrap (`apt install bubblewrap`) or ensure sandbox-exec is in PATH.",
    );
  } else {
    console.log(`[pi-sandbox] Using sandbox provider: ${activeProvider.name}`);
  }

  // ── Bash tool override ──────────────────────────────────────────────────

  const localOps = createLocalBashOperations();
  const sandboxedOps = activeProvider.wrap(localOps, workspaceDir, config);

  const bashTool = createBashTool(workspaceDir, {
    operations: sandboxedOps,
  });
  pi.registerTool(bashTool);

  // ── Path guard for in-process file tools (write, edit) ──────────────────

  function resolveRealPath(targetPath: string): string {
    try {
      return realpathSync(targetPath);
    } catch {
      try {
        const parent = realpathSync(dirname(targetPath));
        return join(parent, basename(targetPath));
      } catch {
        return resolve(targetPath);
      }
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd ?? workspaceDir;

    if (isToolCallEventType("write", event)) {
      const targetPath = event.input?.path;
      if (targetPath) {
        const absolute = resolveRealPath(resolve(cwd, targetPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: write to "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
    }

    if (isToolCallEventType("edit", event)) {
      const targetPath = event.input?.path;
      if (targetPath) {
        const absolute = resolveRealPath(resolve(cwd, targetPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: edit of "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
    }

    if (isToolCallEventType("delete", event)) {
      const targetPath = event.input?.path ?? event.input?.filePath;
      if (targetPath) {
        const absolute = resolveRealPath(resolve(cwd, targetPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: delete of "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
    }

    if (isToolCallEventType("move", event)) {
      const sourcePath = event.input?.path ?? event.input?.source;
      const destPath = event.input?.destination ?? event.input?.target;
      if (sourcePath) {
        const absolute = resolveRealPath(resolve(cwd, sourcePath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: move from "${sourcePath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
      if (destPath) {
        const absolute = resolveRealPath(resolve(cwd, destPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: move to "${destPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
    }
  });

  // ── User bash guard (user-typed !commands) ──────────────────────────────

  pi.on("user_bash", (_event, _ctx) => {
    return {
      operations: sandboxedOps,
    };
  });

  // ── Command: show sandbox status ────────────────────────────────────────

  pi.registerCommand("sandbox-status", {
    description: "Show pi-sandbox status and configuration",
    handler: async (_args, ctx) => {
      const lines = [
        `pi-sandbox v${_version}`,
        `Provider:     ${activeProvider.name}`,
        `Network:      ${config.network ? "allowed" : "blocked"}`,
        `Writable:`,
        ...config.writable.map((p) => `  - ${p}`),
      ];
      if (config.denyWithin.length > 0) {
        lines.push("Deny-within:");
        for (const p of config.denyWithin) {
          lines.push(`  - ${p}`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
