import { appendFileSync } from "node:fs";

// An opt-in marker lets the host prove the correct entry point ran, even offline.
function recordLoad(entry: "server" | "setup"): void {
  const target = process.env.FRUGAL_PLUGIN_LOAD_LOG;
  if (target) {
    appendFileSync(target, JSON.stringify({ plugin: "frugal", entry }) + "\n", { mode: 0o600 });
  }
}

export default {
  id: "frugal",
  async server() {
    recordLoad("server");
    return {};
  },
  setup() {
    recordLoad("setup");
  },
};
