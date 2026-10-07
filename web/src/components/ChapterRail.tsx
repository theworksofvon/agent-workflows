import { ChevronLeft, ChevronRight, CircleCheck, Sparkles } from "lucide-react";
import { fileAnchor, LOW_SIGNAL_ROLES, splitPath } from "../lib/format";
import { Markdown } from "../lib/markdown";
import { useReview } from "../lib/review-context";
import type { GuideChapter, PullRequestFile } from "../types";
import { ChapterStepper } from "./ChapterStepper";
import { FileIcon } from "./FileIcon";

export function ChapterRail({
  chapters,
  index,
  reviewedChapters,
  files,
  onReviewed,
  onSelect,
}: {
  chapters: GuideChapter[];
  index: number;
  reviewedChapters: Record<string, boolean>;
  files: PullRequestFile[];
  onReviewed: (reviewed: boolean) => void;
  onSelect: (index: number) => void;
}) {
  const review = useReview();
  const chapter = chapters[index]!;
  const reviewed = reviewedChapters[chapter.id] === true;
  const lowSignal = LOW_SIGNAL_ROLES.has(chapter.role);
  const hasPrev = index > 0;
  const hasNext = index < chapters.length - 1;

  return (
    <aside className="rail">
      <ChapterStepper
        chapters={chapters}
        index={index}
        reviewed={reviewedChapters}
        onSelect={onSelect}
      />
      <h2 className="rail-title">{chapter.title}</h2>
      <div className="rail-meta">
        <label className="check">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => onReviewed(e.target.checked)}
          />
          Reviewed
        </label>
        <span className={`role role-${chapter.role}`}>{chapter.role}</span>
        {lowSignal && (
          <span className="tag tag-muted" title="Usually safe to skim">
            lower-signal
          </span>
        )}
      </div>
      {chapter.summary && (
        <div className="rail-summary prose">
          <Markdown text={chapter.summary} />
        </div>
      )}
      <ul className="rail-files">
        {files.map((f) => {
          const { dir, name } = splitPath(f.path);
          const findings = review.findingsFor(f.path).length;
          const viewed = review.isViewed(f.path);
          return (
            <li key={f.path}>
              <a
                href={`#${fileAnchor(f.path)}`}
                className={`rail-file ${viewed ? "is-viewed" : ""}`}
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById(fileAnchor(f.path))
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                title={f.path}
              >
                <FileIcon path={f.path} />
                <span className="rail-file-name">{name}</span>
                {viewed && (
                  <CircleCheck
                    size={12}
                    className="rail-file-viewed"
                    aria-label="Viewed"
                  />
                )}
                <span className="rail-file-dir">{dir}</span>
                {findings > 0 && (
                  <span className="rail-file-findings" title="Agent findings">
                    <Sparkles size={11} />
                    {findings}
                  </span>
                )}
                <span className="add">+{f.additions}</span>
              </a>
            </li>
          );
        })}
      </ul>
      <div className="rail-nav">
        <button
          className="btn btn-sm"
          disabled={!hasPrev}
          onClick={() => onSelect(index - 1)}
        >
          <ChevronLeft size={14} />
          Previous
        </button>
        <span className="muted small kbd-hint">
          <kbd>j</kbd> <kbd>k</kbd> chapters · <kbd>r</kbd> reviewed
        </span>
        <button
          className="btn btn-sm"
          disabled={!hasNext}
          onClick={() => onSelect(index + 1)}
        >
          Next
          <ChevronRight size={14} />
        </button>
      </div>
    </aside>
  );
}
