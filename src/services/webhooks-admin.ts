import type { Config } from "../config.js";
import type { RepoRef } from "../domain/events.js";
import { WEBHOOK_EVENTS } from "../domain/webhook.js";
import type {
  GitHubPort,
  HookDelivery,
  HookRecord,
} from "../adapters/github/github.interface.js";

export const WEBHOOK_PATH = "/webhooks/github";

export interface InstallResult {
  repo: RepoRef;
  action: "created" | "updated";
  hookId: number;
  url: string;
}

export interface StatusResult {
  repo: RepoRef;
  hookId: number | null;
  url: string;
  deliveries: HookDelivery[];
}

export async function installWebhooks(args: {
  config: Config;
  github: Pick<GitHubPort, "listHooks" | "createHook" | "updateHook">;
  publicUrl: string;
}): Promise<InstallResult[]> {
  const { config, github } = args;
  const secret = config.webhookSecret;
  if (secret === null)
    throw new Error("Set WEBHOOK_SECRET to install webhooks.");
  const url = targetUrl(args.publicUrl);
  const hook = { url, secret, events: [...WEBHOOK_EVENTS] };

  const results: InstallResult[] = [];
  for (const repo of config.repos) {
    const existing = findHook(await github.listHooks(repo), url);
    // GitHub never returns the secret, so an existing hook is always rewritten.
    const saved = existing
      ? await github.updateHook(repo, existing.id, hook)
      : await github.createHook(repo, hook);
    results.push({
      repo,
      action: existing ? "updated" : "created",
      hookId: saved.id,
      url,
    });
  }
  return results;
}

export async function webhookStatus(args: {
  config: Config;
  github: Pick<GitHubPort, "listHooks" | "listHookDeliveries">;
  publicUrl: string;
}): Promise<StatusResult[]> {
  const { config, github } = args;
  const url = targetUrl(args.publicUrl);
  const results: StatusResult[] = [];
  for (const repo of config.repos) {
    const existing = findHook(await github.listHooks(repo), url);
    results.push({
      repo,
      hookId: existing?.id ?? null,
      url,
      deliveries: existing
        ? await github.listHookDeliveries(repo, existing.id)
        : [],
    });
  }
  return results;
}

function targetUrl(publicUrl: string): string {
  return new URL(WEBHOOK_PATH, publicUrl).toString();
}

function findHook(hooks: HookRecord[], url: string): HookRecord | undefined {
  return hooks.find((hook) => hook.url === url);
}
