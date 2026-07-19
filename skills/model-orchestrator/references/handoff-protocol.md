# Handoff protocol

Use one packet per stage. Keep it short enough for the receiving model to inspect, but complete enough that it can act without reconstructing project history.

```text
TASK
- Objective:
- Non-goals:
- User constraints:

REPOSITORY STATE
- Root / branch / commit:
- Existing user changes: [preserve these]
- Relevant files:
- Baseline checks:

DECISIONS
- Approved design:
- Assumptions:
- Rejected alternatives:

ACCEPTANCE
- Functional criteria:
- Compatibility/API criteria:
- Security/privacy criteria:
- Required tests:

ROLE INSTRUCTIONS
- Role: planner | implementer | reviewer | repairer
- Allowed actions:
- Forbidden actions:
- Output required:

ARTIFACTS
- Plan:
- Diff or changed files:
- Test commands/results:
- Review findings:
- Open questions:
```

Role-specific output:

- Planner: decision-ready plan, risks, and test strategy; no code edits.
- Implementer: changed files, rationale tied to the plan, tests run, failures, and follow-up concerns.
- Reviewer: findings first, ranked blocker/high/medium/low; file/line evidence; explicitly say when no findings were found.
- Repairer: finding-to-change mapping, tests rerun, and any finding that remains unresolved.

Do not pass hidden chain-of-thought or ask a model to reproduce it. Pass conclusions, evidence, decisions, and artifacts instead.
