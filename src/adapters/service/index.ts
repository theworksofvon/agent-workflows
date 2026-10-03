import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { launchdManager } from "./launchd.js";
import { systemdManager } from "./systemd.js";
import type { ServiceDeps, ServiceManagerPort } from "./service.interface.js";

const execFileAsync = promisify(execFile);

export function serviceManagerFor(
  platform: NodeJS.Platform,
  deps: ServiceDeps,
): ServiceManagerPort {
  if (platform === "darwin") return launchdManager(deps);
  if (platform === "linux") return systemdManager(deps);
  if (platform === "win32") {
    throw new Error("Windows is not a supported service target.");
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export function defaultDeps(): ServiceDeps {
  return {
    run: async (cmd, args) => {
      await execFileAsync(cmd, args);
    },
    home: homedir(),
    writeFile: (p, s) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s);
    },
    mkdir: (p) => {
      mkdirSync(p, { recursive: true });
    },
    rm: (p) => rmSync(p, { force: true }),
    uid: process.getuid?.() ?? 0,
  };
}
