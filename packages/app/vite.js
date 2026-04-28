import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  // Theme preload is served as an external file (`/oc-theme-preload.js`) so
  // the embedded server's strict CSP (`script-src 'self' 'wasm-unsafe-eval'`)
  // does not need a hash exception or `'unsafe-inline'`. The earlier
  // build-time inline substitution traded a sub-millisecond round-trip on
  // localhost for inline-script CSP friction; not worth the complexity.
  // Refs upstream PR anomalyco/opencode#18985, upstream issue
  // anomalyco/opencode#18325.
  tailwindcss(),
  solidPlugin(),
]
