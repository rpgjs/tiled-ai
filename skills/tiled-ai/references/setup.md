# Automatic local setup

Use this procedure when setup is requested or needed for the user's Tiled task. It requires local shell/filesystem access. Keep the user's existing installation, configuration and unrelated extensions. Do not require a new approval for every reversible setup step already covered by the request.

## Locate the installation

Check available MCP tools first. If `get_editor_state` is callable, call it before changing configuration. Discover exact tool names; do not guess the namespace. An empty search means the task lacks tools, not that Tiled is disconnected.

Find the repository using the current workspace, an existing `tiled-ai` MCP command or a user-provided path. An installed skill may contain only instructions: do not assume its directory contains `package.json` or `dist`. If no checkout exists, clone `https://github.com/rpgjs/tiled-ai.git` into a suitable local tools directory under the user's home. Never replace an existing nonempty directory or reset a dirty checkout. Resolve the repository path absolutely.

Check Node.js 24 or newer and npm. Use an available compatible runtime; do not replace the user's global Node installation. If none is available, explain the missing prerequisite. Check Tiled via an explicitly supplied executable, `TILED_APPIMAGE` or `tiled` on PATH. If it is already running, its executable path can provide context. Do not download an arbitrary Tiled binary.

From the verified checkout, install missing dependencies with `npm ci`, then build with `npm run build`. Avoid reinstalling dependencies when a working installation already satisfies the lockfile.

## Install the extension

Run `node dist/cli.mjs init` and `node dist/cli.mjs doctor`. Both accept `--config <absolute-path>`; retain any existing custom configuration. Do not print the contents of configuration files containing the secret.

Determine the actual Tiled extension directory from its preferences, existing installation or platform configuration. On a standard Linux installation it is `${XDG_CONFIG_HOME:-$HOME/.config}/tiled/extensions`; on Windows it is `%LOCALAPPDATA%\Tiled\extensions`, which is independent of the Tiled installation directory and is created when Tiled first runs. Do not apply either path to macOS or a custom installation. If the location remains uncertain, ask for the directory shown in Tiled Preferences instead of installing into a guessed location.

Run `node dist/cli.mjs install --extensions <absolute-extension-directory>` using the same `--config` when customized. This installs only `tiled-ai.mjs` and `tiled-ai.config.json`; it must not remove other extensions. A first install or changed extension requires Tiled to reload the extension. Launch Tiled if it is not running and its executable is known. Do not terminate a running editor with unsaved documents to force a reload. If editor interaction is unavailable, ask the user to restart Tiled and later choose **Map → Tiled AI: Connect**.

## Configure Codex and start the bridge

For Codex, inspect `codex mcp get tiled-ai`. If absent, add a stdio server using the verified absolute Node executable and CLI path:

```sh
codex mcp add tiled-ai -- /absolute/path/to/node /absolute/path/to/tiled-ai/dist/cli.mjs serve
```

For a custom bridge configuration append `--config /absolute/path/to/config.json` after `serve`. If an entry already exists, preserve it when correct; correct only its relevant fields when demonstrably wrong. Do not overwrite the whole Codex configuration or expose other servers' credentials. Use the equivalent configuration mechanism for a different MCP client.

Run `node dist/cli.mjs bridge-start` with the same optional `--config`. This returns promptly, starts the shared background bridge if absent, or reuses the existing authenticated bridge. Do not leave a foreground `serve` command running in a terminal just to keep the bridge alive. Codex starts its own stdio clients.

`BRIDGE_INCOMPATIBLE` means the configured port is occupied by an older server, another secret or an incompatible service. Identify the owner before stopping anything. For a known shared bridge that needs an update, `bridge-stop` then `bridge-start` reloads it; Tiled must reconnect afterward. Never kill an arbitrary process merely because it owns the port.

## Verify each boundary

1. Extension files exist in the verified directory, and Tiled has loaded the **Tiled AI** actions.
2. `bridge-start` reports the authenticated shared bridge as available.
3. Codex has a `tiled-ai` stdio configuration and the current task actually exposes its tools. Configuration presence or server startup status alone does not prove tool exposure.
4. Call the discovered `get_editor_state` tool. If it returns no sessions, connect Tiled. If it returns a session, inspect the intended document before editing.

After adding or changing MCP configuration, refresh the integration if the client supports it. A new task or application restart may be needed. Shell commands and this skill cannot force new tools into the current task. Do not fabricate a tool call or treat a JavaScript `TypeError: ... is not a function` as an editor error. State exactly what remains to load and avoid repeatedly reinstalling a working server.

Keep any secrets, configuration files and local paths out of the shared repository. Report completed setup steps and the actual verification result; do not claim that the task can use MCP until a discovered tool call succeeds.
