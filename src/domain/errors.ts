export class DomainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class ReportMissingError extends DomainError {
  constructor(public readonly path: string) {
    super(`agent produced no report at ${path}`);
  }
}
export class ReportInvalidError extends DomainError {}
export class DraftPullRequestError extends DomainError {
  constructor(slug: string) {
    super(
      `PR ${slug} is a draft; review mode only runs on ready-for-review PRs.`,
    );
  }
}
/** GitHub refused a request because the account hit a rate limit. */
export class RateLimitedError extends DomainError {}
/** The server stopped, so a run must not write to the closed database. */
export class ServerStoppedError extends DomainError {
  constructor() {
    super("the server stopped during this run");
  }
}
