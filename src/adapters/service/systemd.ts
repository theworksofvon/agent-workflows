import { join } from "node:path";
import type { ServiceDeps, ServiceManagerPort } from "./service.interface.js";

const UNIT = "agent-workflows.service";

export function systemdManager(deps: ServiceDeps): ServiceManagerPort {
  const unitPath = () => join(deps.home, ".config", "systemd", "user", UNIT);
  const systemctl = (...args: string[]) =>
    deps.run("systemctl", ["--user", ...args]);

  return {
    name: "systemd",
    unitPath,
    render: (spec) => `[Unit]
Description=agent-workflows daemon

[Service]
ExecStart=${spec.nodePath} ${spec.entryPath}
WorkingDirectory=${spec.cwd}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
    async install(spec) {
      const path = unitPath();
      deps.mkdir(spec.logDir);
      deps.writeFile(path, this.render(spec));
      await systemctl("daemon-reload");
      await systemctl("enable", "--now", UNIT);
      // Linger keeps the user manager alive after logout; unavailable on some hosts.
      try {
        await deps.run("loginctl", ["enable-linger"]);
      } catch {
        // best effort
      }
      return path;
    },
    async uninstall() {
      try {
        await systemctl("disable", "--now", UNIT);
      } catch {
        // not enabled
      }
      deps.rm(unitPath());
      await systemctl("daemon-reload");
    },
  };
}
