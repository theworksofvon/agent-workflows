import { execFile } from "node:child_process";
import { log } from "../../log.js";
import type { TailscalePort } from "./tailscale.interface.js";

type Run = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

/** Resolves with the exit code on non-zero exit; rejects only when the binary cannot run. */
export function execRun(binary: string): Run {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err && typeof err.code !== "number") {
            reject(err);
            return;
          }
          resolve({ stdout, exitCode: err ? (err.code as number) : 0 });
        },
      );
    });
}

export function tailscaleCli(run: Run = execRun("tailscale")): TailscalePort {
  const call: Run = async (args) => {
    try {
      return await run(args);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const label =
        (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
          ? "tailscale is not installed or not on PATH"
          : "tailscale command failed";
      throw new Error(`${label}: ${reason}`, { cause: err });
    }
  };

  const currentUrl = async (): Promise<string> => {
    const status = await call(["status", "--json", "--peers=false"]);
    if (status.exitCode !== 0) {
      throw new Error(`tailscale status failed (exit ${status.exitCode})`);
    }
    const parsed = JSON.parse(status.stdout) as { Self?: { DNSName?: string } };
    const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
    if (!dnsName) throw new Error("tailscale status has no Self.DNSName");
    return `https://${dnsName}`;
  };

  return {
    async funnelOn(port) {
      const result = await call(["funnel", "--bg", String(port)]);
      if (result.exitCode !== 0) {
        throw new Error(`tailscale funnel failed (exit ${result.exitCode})`);
      }
      return currentUrl();
    },
    async funnelOff(port) {
      const result = await call(["funnel", "--bg", String(port), "off"]);
      if (result.exitCode !== 0) {
        log.warn("tailscale funnel off failed", { exitCode: result.exitCode });
      }
    },
    currentUrl,
  };
}
