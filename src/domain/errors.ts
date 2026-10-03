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
/** The remote branch moved since the worktree was fetched; the lease held. */
export class PushRejectedError extends DomainError {
  constructor(
    public readonly branch: string,
    options?: ErrorOptions,
  ) {
    super(`push of ${branch} rejected: remote branch moved`, options);
  }
}
export class DraftPullRequestError extends DomainError {
  constructor(slug: string) {
    super(
      `PR ${slug} is a draft; review mode only runs on ready-for-review PRs.`,
    );
  }
}
export class InvalidTargetError extends DomainError {}
