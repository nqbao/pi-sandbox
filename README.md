# @nqbao/pi-sandbox

OS-level sandbox extension for Pi.

This package overrides Pi's bash tool and applies an OS sandbox:
- macOS: `sandbox-exec`
- Linux: `bubblewrap`

It also blocks in-process file mutations outside configured writable paths.

## Install

Install from npm through Pi:

```bash
pi install npm:@nqbao/pi-sandbox
```

Or load it locally during development:

```bash
pi -e ./index.ts
```

## What It Does

`pi-sandbox` adds two layers of protection:

- It overrides Pi's `bash` tool and runs shell commands inside an OS sandbox.
- It intercepts file tools and blocks writes outside configured writable roots. It can also block selected read paths for `read`, `grep`, `find`, and `ls`.

Behavior depends on the platform:

- macOS: uses `sandbox-exec`
- Linux: uses `bubblewrap`
- if no supported provider is available and sandboxing is enabled: bash commands fail with an error rather than running unsandboxed

## Configuration

The extension reads `sandbox.json` from:

- `$(pi agent dir)/sandbox.json`
- `~/.pi/agent/sandbox.json`

Supported fields:

- `enabled`: turn the extension on or off globally
- `allowRead`: paths to opt out of the default read deny list (see below)
- `denyRead`: additional paths to block for Pi's built-in read-only file tools
- `writable`: directories Pi is allowed to modify
- `denyWithin`: subpaths that stay blocked even if they are inside a writable directory
- `network`: whether outbound network access is allowed
- `provider`: `auto`, `sandbox-exec`, `bubblewrap`, or `none`

Example:

```json
{
  "enabled": true,
  "allowRead": ["${HOME}/.ssh"],
  "denyRead": ["${HOME}/.config/my-secrets"],
  "writable": ["${WORKSPACE}", "${TMP}"],
  "denyWithin": ["${WORKSPACE}/.git/hooks"],
  "network": true,
  "provider": "auto"
}
```

Available path variables:

- `${WORKSPACE}`: the current project directory
- `${HOME}`: your home directory (a leading `~/` works too)
- `${AGENT_DIR}`: the Pi agent directory (`~/.pi/agent` by default)
- `${TMP}` and `${TMPDIR}`: the system temporary directory

By default, the extension allows writes to:

- `${WORKSPACE}`
- `${TMP}`
- Pi agent dir

By default, the extension blocks reads from the following sensitive paths:

- `${HOME}/.ssh`
- `${HOME}/.aws`
- `${HOME}/.gnupg`
- `${HOME}/.config/gcloud`
- `${HOME}/.netrc`
- `${HOME}/.git-credentials`
- Developer tool and cloud CLI tokens: `${HOME}/.config/gh`, `${HOME}/.npmrc`, `${HOME}/.pypirc`, `${HOME}/.cargo/credentials.toml`, `${HOME}/.docker/config.json`, `${HOME}/.kube`, `${HOME}/.azure`, `${HOME}/.terraform.d/credentials.tfrc.json`, `${HOME}/.vault-token`
- Password managers: `${HOME}/.password-store`, `${HOME}/.config/op`
- Browser profiles and cookies (macOS): `${HOME}/Library/Application Support/Google/Chrome`, `${HOME}/Library/Application Support/Firefox`, `${HOME}/Library/Cookies`
- Pi's API keys: `auth.json` in the Pi agent dir
- `/etc/shadow`
- `/etc/sudoers`

Commands keep working without these files, but anything that needs the token fails. For example, `npm install` from the public registry still works while publishing does not, and `gh` and `kubectl` can't authenticate.

Use `allowRead` to unblock any of these. `sandbox.json` is global, so this applies to every project. To unblock a denied directory such as `${HOME}/.kube`, list the directory itself; an entry for a file inside it is ignored with a warning. If a path appears in both `allowRead` and `denyRead`, deny wins and a warning is logged.

```json
{
  "allowRead": ["~/.npmrc", "${HOME}/.kube", "${AGENT_DIR}/auth.json"]
}
```

`--sandbox-readonly` is a quick way to disable all filesystem writes regardless of `writable`, while keeping read access governed by the existing deny policy.

For recursive read tools like `grep` and `find`, pi-sandbox blocks starting from a parent path that would traverse into a denied subtree.

And blocks writes to:

- `${WORKSPACE}/.git/hooks`
- `${WORKSPACE}/.git/config`, because settings like `core.hooksPath`, `core.fsmonitor` and `core.sshCommand` run commands the next time you use git outside the sandbox. Everyday git commands (status, commit, branch, push) still work. Commands that change the repo config don't: `git config`, `git remote add`, and the upstream step of `git push -u` (the branch is pushed, but its upstream isn't saved). Run those yourself, or set `denyWithin` to replace the defaults.

These Pi paths are always write-protected, whatever `writable` or `denyWithin` say, because Pi loads code, credentials, or trust decisions from them on the next start:

- `${WORKSPACE}/.pi` (project extensions, packages, settings, prompts)
- in the Pi agent dir: `extensions/`, `npm/`, `git/`, `settings.json`, `trust.json`, `mcp.json`, `models.json`, `auth.json`, `sandbox.json`

On Linux, bubblewrap can only mount existing paths read-only. So before a bash command runs, a missing protected directory is created empty (for example an empty `.pi/` in the workspace). If a protected file is missing, its parent directory is mounted read-only for that command; the parent's existing entries stay writable.

Paths are resolved through symlinks before they are checked, including paths that don't exist yet, so a write through a symlinked directory is checked against its real target.

## Status Command

The extension registers a Pi command:

```text
/sandbox-status
```

It shows the active provider, network mode, writable paths, and deny rules.

Runtime controls:

```text
/sandbox-enable
/sandbox-disable
/sandbox-reset
```

Startup flags:

```bash
pi -e ./index.ts --sandbox
pi -e ./index.ts --sandbox-readonly
pi -e ./index.ts --no-sandbox
```

## Package

This is a Pi package and exposes its extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
