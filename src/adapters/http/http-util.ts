import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Neither server takes a body this large; a bigger upload gets a 413. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

/** Listens on host:port and resolves once the port is bound. */
export function listen(
  server: Server,
  host: string,
  port: number,
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      // A TCP listener always reports an AddressInfo, carrying the real port for port 0.
      const { port: bound } = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${bound}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            // Open or keep-alive connections must not hold up shutdown.
            server.closeAllConnections();
          }),
      });
    });
  });
}

/**
 * Collects the request body as text and hands it to `onBody`. Past
 * MAX_BODY_BYTES it answers 413 with `tooLarge` instead and never calls it.
 */
export function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  tooLarge: unknown,
  onBody: (raw: string) => void,
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
    send(res, 413, tooLarge);
  };
  const onEnd = (): void => onBody(Buffer.concat(chunks).toString("utf8"));
  req.on("data", onData);
  req.on("end", onEnd);
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
