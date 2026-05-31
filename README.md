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
- `${HOME}`: your home directory
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
- `/etc/shadow`
- `/etc/sudoers`

Use `allowRead` to unblock any of these for a specific project. If a path appears in both `allowRead` and `denyRead`, deny wins and a warning is logged.

`--sandbox-readonly` is a quick way to disable all filesystem writes regardless of `writable`, while keeping read access governed by the existing deny policy.

For recursive read tools like `grep` and `find`, pi-sandbox blocks starting from a parent path that would traverse into a denied subtree.

And blocks writes to:

- `${WORKSPACE}/.git/hooks`

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
