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
export class InvalidTargetError extends DomainError {}
