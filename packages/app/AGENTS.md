## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

- `opencode dev web` serves embedded UI assets when available. It fails closed with a local `503` page if assets are missing or disabled; it does not proxy `https://app.opencode.ai`.
- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev`
- Open `http://localhost:3000` to verify UI changes (it targets the backend at `http://localhost:4096`).
- The Vite dev server binds to `127.0.0.1` and stays proxy-free.
- The app root (`/`) opens the native dashboard. The legacy home route is `/home`.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
