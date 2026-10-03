import { join } from "node:path";
import type {
  ServiceDeps,
  ServiceManagerPort,
  ServiceSpec,
} from "./service.interface.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function launchdManager(deps: ServiceDeps): ServiceManagerPort {
  const unitPath = (spec: ServiceSpec) =>
    join(deps.home, "Library", "LaunchAgents", `${spec.label}.plist`);
  const domain = `gui/${deps.uid}`;
  // bootout fails when the agent is not loaded, which is the normal first-run state.
  const bootout = async (path: string) => {
    try {
      await deps.run("launchctl", ["bootout", domain, path]);
    } catch {
      // not loaded
    }
  };

  return {
    name: "launchd",
    unitPath,
    render: (spec) => {
      const s = (value: string) => `<string>${escapeXml(value)}</string>`;
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(spec.label)}
  <key>ProgramArguments</key>
  <array>
    ${s(spec.nodePath)}
    ${s(spec.entryPath)}
  </array>
  <key>WorkingDirectory</key>
  ${s(spec.cwd)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${s(join(spec.logDir, "agent-workflows.log"))}
  <key>StandardErrorPath</key>
  ${s(join(spec.logDir, "agent-workflows.err.log"))}
</dict>
</plist>
`;
    },
    async install(spec) {
      const path = unitPath(spec);
      deps.mkdir(spec.logDir);
      deps.writeFile(path, this.render(spec));
      await bootout(path);
      await deps.run("launchctl", ["bootstrap", domain, path]);
      return path;
    },
    async uninstall(spec) {
      const path = unitPath(spec);
      await bootout(path);
      deps.rm(path);
    },
  };
}
