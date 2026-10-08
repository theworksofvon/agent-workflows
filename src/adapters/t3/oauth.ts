import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../../domain/errors.js";

/** T3 refused a sign-in step; the message says which and why. */
export class T3SignInError extends DomainError {}

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

export interface T3Token {
  token: string;
  /** ISO time; T3 issues no refresh token, so the reviewer signs in again after it. */
  expiresAt: string;
}

/**
 * The OAuth flow of T3 Code's outside-agent MCP endpoint: dynamic client
 * registration, then an authorization code with PKCE S256. T3 only issues a
 * token for its `<origin>/mcp` resource, so every step names it.
 */
export function t3OAuth(mcpUrl: string) {
  const origin = new URL(mcpUrl).origin;
  const resource = `${origin}/mcp`;
  let metadata: Promise<Metadata> | null = null;
  const meta = () =>
    (metadata ??= json<Metadata>(
      `${origin}/.well-known/oauth-authorization-server`,
    ).catch((err: unknown) => {
      metadata = null;
      throw err;
    }));

  return {
    /** Registers the app as a public client and returns its client id. */
    async register(redirectUri: string): Promise<string> {
      const { registration_endpoint } = await meta();
      const client = await json<{ client_id: string }>(registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Guided Review",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "none",
        }),
      });
      return client.client_id;
    },

    async authorizeUrl(args: {
      clientId: string;
      redirectUri: string;
      state: string;
      challenge: string;
    }): Promise<string> {
      const url = new URL((await meta()).authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: args.clientId,
        redirect_uri: args.redirectUri,
        state: args.state,
        code_challenge: args.challenge,
        code_challenge_method: "S256",
        resource,
      }).toString();
      return url.href;
    },

    async exchange(args: {
      clientId: string;
      redirectUri: string;
      code: string;
      verifier: string;
    }): Promise<T3Token> {
      const { token_endpoint } = await meta();
      const issued = await json<{ access_token: string; expires_in: number }>(
        token_endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: args.code,
            redirect_uri: args.redirectUri,
            client_id: args.clientId,
            code_verifier: args.verifier,
            resource,
          }).toString(),
        },
      );
      return {
        token: issued.access_token,
        expiresAt: new Date(
          Date.now() + issued.expires_in * 1000,
        ).toISOString(),
      };
    },
  };
}

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    let reason = text;
    try {
      const body = JSON.parse(text) as Record<string, string>;
      reason = body.error_description ?? body.error ?? text;
    } catch {
      // The body is not JSON; its text is the reason.
    }
    throw new T3SignInError(
      `T3 refused ${new URL(url).pathname} (${res.status}): ${reason}`,
    );
  }
  return JSON.parse(text) as T;
}
