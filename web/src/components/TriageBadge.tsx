import { RISK_LABELS, type Triage } from "../types";

/** `deep · risk High · heuristic`; reasons in the tooltip. Old sessions can name the retired `systemone:` engine. */
export function TriageBadge({ triage }: { triage: Triage | null }) {
  if (!triage) return null;
  const engine = triage.engine.replace(/^systemone:/, "");
  const confidence =
    triage.confidence === null ? "" : ` ${triage.confidence.toFixed(2)}`;
  const risk = RISK_LABELS[triage.risk] ?? String(triage.risk);
  const title = [
    `Depth: ${triage.depth}`,
    `Risk: ${risk} (${triage.risk} of 4)`,
    `Guide needed: ${triage.needsGuide ? "yes" : "no"}`,
    `Engine: ${triage.engine}`,
    ...(triage.reasons.length ? [`Reasons: ${triage.reasons.join(", ")}`] : []),
  ].join("\n");
  return (
    <span className={`triage triage-${triage.depth}`} title={title}>
      <span className="triage-depth">{triage.depth}</span>
      <span className="triage-sep">·</span>
      <span className={`triage-risk risk-${triage.risk}`}>risk {risk}</span>
      <span className="triage-sep">·</span>
      <span className="triage-engine">
        {engine}
        {confidence}
      </span>
    </span>
  );
}
