import { ChevronRight, Sparkles, X } from "lucide-react";
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { fileAnchor, plural, SEVERITY_ORDER, splitPath } from "../lib/format";
import { highlightHunks, type HunkTokens, type Token } from "../lib/highlight";
import {
  newLinesPast,
  newSideLines,
  parsePatch,
  type PatchLine,
} from "../lib/patch";
import { useReview } from "../lib/review-context";
import type { ApiFinding, HumanComment, PullRequestFile } from "../types";
import { CommentComposer } from "./CommentComposer";
import { FileIcon } from "./FileIcon";
import { FindingCard } from "./FindingCard";
import { HumanCommentCard } from "./HumanCommentCard";

/** Files longer than this show their first lines and a "Show all" button. */
const COLLAPSE_LINES = 400;

export const FileDiff = memo(function FileDiff({
  file,
}: {
  file: PullRequestFile;
}) {
  const review = useReview();
  const viewed = review.isViewed(file.path);
  const [open, setOpen] = useState(!viewed);
  const [showAll, setShowAll] = useState(false);
  const [composerLine, setComposerLine] = useState<number | null>(null);
  const [tokens, setTokens] = useState<HunkTokens | null>(null);

  const hunks = useMemo(() => parsePatch(file.patch), [file.patch]);
  const totalLines = hunks.reduce((n, h) => n + h.lines.length, 0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    highlightHunks(file.path, hunks).then(
      (t) => live && setTokens(t),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, file.path, hunks]);

  // A jump from the overview to a finding in this file opens it in full.
  const focusHere = review.focus?.path === file.path;
  const refFocus =
    focusHere && review.focus && "lines" in review.focus ? review.focus : null;
  const refSpan = useMemo(
    () => (refFocus ? spanOf(hunks, refFocus.lines) : null),
    [hunks, refFocus],
  );
  useEffect(() => {
    if (!focusHere) return;
    setOpen(true);
    setShowAll(true);
  }, [focusHere]);

  const findings = review.findingsFor(file.path);
  const comments = review.commentsFor(file.path);
  const onDiff = useMemo(() => newSideLines(hunks), [hunks]);
  const findingsAt = groupByLine(findings.filter((f) => onDiff.has(f.line)));
  const commentsAt = groupByLine(comments.filter((c) => onDiff.has(c.line)));
  const outsideFindings = findings.filter((f) => !onDiff.has(f.line));
  const outsideComments = comments.filter((c) => !onDiff.has(c.line));
  const collapsed = useMemo(
    () => newLinesPast(hunks, COLLAPSE_LINES),
    [hunks],
  );
  const hiddenFindings = showAll
    ? 0
    : findings.filter((f) => collapsed.has(f.line)).length;
  const hiddenComments = showAll
    ? 0
    : comments.filter((c) => collapsed.has(c.line)).length;

  function toggleViewed() {
    review.setViewed(file.path, !viewed);
    setOpen(viewed);
  }

  function annotations(line: number): ReactNode {
    const lineFindings = findingsAt.get(line) ?? [];
    const lineComments = commentsAt.get(line) ?? [];
    if (!lineFindings.length && !lineComments.length && composerLine !== line)
      return null;
    return (
      <tr className="dl-annot">
        <td colSpan={3}>
          <div className="annots">
            {lineFindings.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                verdict={review.verdictFor(f.id)}
                onChange={(v, note) => review.setVerdict(f.id, v, note)}
              />
            ))}
            {lineComments.map((c) => (
              <HumanCommentCard
                key={c.id}
                comment={c}
                onDelete={() => review.deleteComment(c.id)}
              />
            ))}
            {composerLine === line && (
              <CommentComposer
                line={line}
                onSubmit={(body) => review.addComment(file.path, line, body)}
                onCancel={() => setComposerLine(null)}
              />
            )}
          </div>
        </td>
      </tr>
    );
  }

  const rows: ReactNode[] = [];
  let shown = 0;
  const limit = showAll ? Infinity : COLLAPSE_LINES;
  let flat = -1;
  outer: for (const [h, hunk] of hunks.entries()) {
    rows.push(
      <tr className="dl-hunk" key={`h${h}`}>
        <td className="gutter" colSpan={2} aria-hidden>
          ⋯
        </td>
        <td className="code">{hunk.header}</td>
      </tr>,
    );
    for (const [i, line] of hunk.lines.entries()) {
      if (shown >= limit) break outer;
      shown += 1;
      flat += 1;
      if (refFocus && refSpan && flat === refSpan.first)
        rows.push(
          <tr className="dl-ref-label" key="ref-label">
            <td colSpan={3}>
              <span className="dl-ref-tag">Flow step</span>
              <span className="dl-ref-text">{refFocus.label}</span>
              <span className="dl-ref-lines">
                {refFocus.lines.end > refFocus.lines.start
                  ? `lines ${refFocus.lines.start}–${refFocus.lines.end}`
                  : `line ${refFocus.lines.start}`}
              </span>
              <button
                type="button"
                className="dl-ref-close"
                aria-label="Clear the highlight"
                onClick={review.clearFocus}
              >
                <X size={13} />
              </button>
            </td>
          </tr>,
        );
      rows.push(
        <DiffLine
          key={`${h}:${i}`}
          line={line}
          marked={
            refSpan === null || flat < refSpan.first || flat > refSpan.last
              ? null
              : flat === refSpan.last
                ? "end"
                : "in"
          }
          tokens={tokens?.[h]?.[i]}
          active={composerLine !== null && composerLine === line.newLine}
          onComment={setComposerLine}
        />,
      );
      if (line.newLine !== null) {
        const extra = annotations(line.newLine);
        if (extra)
          rows.push(<Fragment key={`a${h}:${i}`}>{extra}</Fragment>);
      }
    }
  }

  const { dir, name } = splitPath(file.path);
  const worst = SEVERITY_ORDER.find((s) =>
    findings.some((f) => f.severity === s),
  );

  return (
    <section
      className={`file card ${viewed ? "is-viewed" : ""}`}
      id={fileAnchor(file.path)}
    >
      <header className="file-head">
        <button
          type="button"
          className={`chevron ${open ? "is-open" : ""}`}
          aria-label={open ? "Collapse file" : "Expand file"}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={15} />
        </button>
        <FileIcon path={file.path} />
        <button
          type="button"
          className="file-name"
          onClick={() => setOpen(!open)}
        >
          <span className="file-base">{name}</span>
          <span className="file-dir">{dir}</span>
        </button>
        <span className="spacer" />
        {findings.length > 0 && (
          <span className={`count-chip sev-${worst}`} title="Agent findings">
            <Sparkles size={11} />
            {findings.length}
          </span>
        )}
        {comments.length > 0 && (
          <span className="count-chip human-chip" title="Your comments">
            You {comments.length}
          </span>
        )}
        <span className="file-status">{file.status}</span>
        <span className="stat">
          <span className="add">+{file.additions}</span>
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
        <label className="check">
          <input type="checkbox" checked={viewed} onChange={toggleViewed} />
          Viewed
        </label>
      </header>
      {open && (
        <div className="file-body">
          {(outsideFindings.length > 0 || outsideComments.length > 0) && (
            <div className="outside">
              <div className="outside-title">Outside the diff</div>
              <p className="muted small">
                These point at lines this PR does not change. They cannot post
                inline; the published review lists them in its body.
              </p>
              {outsideFindings.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  showLocation
                  verdict={review.verdictFor(f.id)}
                  onChange={(v, note) => review.setVerdict(f.id, v, note)}
                />
              ))}
              {outsideComments.map((c) => (
                <HumanCommentCard
                  key={c.id}
                  comment={c}
                  showLocation
                  onDelete={() => review.deleteComment(c.id)}
                />
              ))}
            </div>
          )}
          {hiddenFindings + hiddenComments > 0 && (
            <button
              type="button"
              className="show-all show-all-top"
              onClick={() => setShowAll(true)}
            >
              {[
                hiddenFindings && plural(hiddenFindings, "finding"),
                hiddenComments && plural(hiddenComments, "comment"),
              ]
                .filter(Boolean)
                .join(" and ")}{" "}
              below the fold — Show all
            </button>
          )}
          {file.patch === null ? (
            <div className="no-diff muted">
              No text diff from GitHub (binary file, rename only, or too large).
            </div>
          ) : (
            <table className="diff">
              <colgroup>
                <col className="col-gutter" />
                <col className="col-gutter" />
                <col />
              </colgroup>
              <tbody>{rows}</tbody>
            </table>
          )}
          {shown < totalLines && (
            <button
              type="button"
              className="show-all"
              onClick={() => setShowAll(true)}
            >
              Show all {plural(totalLines, "line")} ({totalLines - shown}{" "}
              hidden)
            </button>
          )}
        </div>
      )}
    </section>
  );
});

const DiffLine = memo(function DiffLine({
  line,
  tokens,
  active,
  marked,
  onComment,
}: {
  line: PatchLine;
  tokens: Token[] | undefined;
  active: boolean;
  /**
   * Inside the line range of the flow step that the reviewer opened; "end"
   * on the last row, which closes the box.
   */
  marked: "in" | "end" | null;
  onComment: (line: number) => void;
}) {
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <tr
      className={`dl dl-${line.kind} ${active ? "is-active" : ""} ${marked ? "is-ref" : ""} ${marked === "end" ? "is-ref-end" : ""}`}
    >
      <td className="gutter">{line.oldLine}</td>
      <td className="gutter">
        {line.newLine !== null && (
          <button
            type="button"
            className="ln"
            title={`Comment on line ${line.newLine}`}
            onClick={() => onComment(line.newLine!)}
          >
            {line.newLine}
          </button>
        )}
      </td>
      <td className="code">
        <span className="sign" aria-hidden>
          {sign}
        </span>
        {tokens
          ? tokens.map((t, i) => (
              <span key={i} style={t.style as CSSProperties | undefined}>
                {t.content}
              </span>
            ))
          : line.text}
      </td>
    </tr>
  );
});


function groupByLine<T extends ApiFinding | HumanComment>(
  items: T[],
): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const list = map.get(item.line);
    if (list) list.push(item);
    else map.set(item.line, [item]);
  }
  return map;
}

/**
 * The rows, counted across hunks in display order, from the first to the
 * last line of `lines` on the new side. Deleted rows between them belong to
 * the span, so the box around it has no gaps.
 */
function spanOf(
  hunks: ReturnType<typeof parsePatch>,
  lines: { start: number; end: number },
): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  let flat = -1;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      flat += 1;
      const n = line.newLine;
      if (n === null || n < lines.start || n > lines.end) continue;
      if (first < 0) first = flat;
      last = flat;
    }
  return first < 0 ? null : { first, last };
}
