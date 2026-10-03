import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { RawDelivery } from "../../domain/events.js";
import { log } from "../../log.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ListenerHandle {
  url: string;
  close(): Promise<void>;
}

export type DeliveryHandler = (
  delivery: RawDelivery,
) => Promise<{ status: number; reason: string }>;

/**
 * Serves `POST /webhooks/github` and `GET /healthz`. The body is handed over
 * exactly as received so the signature can be checked against it.
 */
export function startWebhookListener(args: {
  host: string;
  port: number;
  onDelivery: DeliveryHandler;
}): Promise<ListenerHandle> {
  const server = createServer((req, res) => {
    // A server-side request always carries a URL; the typing is shared with clients.
    const url = new URL(String(req.url), "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz")
      return send(res, 200, { ok: true });
    if (req.method !== "POST" || url.pathname !== "/webhooks/github")
      return send(res, 404, { reason: "not-found" });
    receive(req, res, args.onDelivery);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, () => {
      // A TCP listener always reports an AddressInfo, carrying the real port for port 0.
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${args.host}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function receive(
  req: IncomingMessage,
  res: ServerResponse,
  onDelivery: DeliveryHandler,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  const onData = (chunk: Buffer): void => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) {
      chunks.push(chunk);
      return;
    }
    req.off("data", onData);
    req.off("end", onEnd);
    // Closing the connection drops the rest of an oversized upload unread.
    res.setHeader("connection", "close");
    send(res, 413, { reason: "payload-too-large" });
  };
  const onEnd = (): void => {
    const delivery: RawDelivery = {
      id: header(req, "x-github-delivery") ?? "",
      event: header(req, "x-github-event") ?? "",
      signature256: header(req, "x-hub-signature-256") ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    void respond(res, delivery, onDelivery);
  };
  req.on("data", onData);
  req.on("end", onEnd);
}

async function respond(
  res: ServerResponse,
  delivery: RawDelivery,
  onDelivery: DeliveryHandler,
): Promise<void> {
  const meta = { id: delivery.id, event: delivery.event };
  try {
    const result = await onDelivery(delivery);
    if (result.status < 200 || result.status > 299)
      log.warn("webhook delivery not accepted", {
        ...meta,
        status: result.status,
        reason: result.reason,
      });
    send(res, result.status, { reason: result.reason });
  } catch (err) {
    log.error("webhook delivery failed", { ...meta, error: String(err) });
    send(res, 500, { reason: "internal-error" });
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  return req.headersDistinct[name]?.[0];
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
