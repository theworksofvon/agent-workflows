import { ArrowRight } from "lucide-react";
import { pad2 } from "../lib/format";
import type { GuideChapter, HumanState, PullRequestFile } from "../types";
import { ChapterRail } from "./ChapterRail";
import { FileDiff } from "./FileDiff";

export function GuideTab({
  chapters,
  index,
  files,
  human,
  onReviewed,
  onSelect,
}: {
  chapters: GuideChapter[];
  index: number;
  files: PullRequestFile[];
  human: HumanState;
  onReviewed: (chapterId: string, reviewed: boolean) => void;
  onSelect: (index: number) => void;
}) {
  const chapter = chapters[index]!;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const chapterFiles = chapter.files
    .map((p) => byPath.get(p))
    .filter((f): f is PullRequestFile => f !== undefined);
  const next = chapters[index + 1];

  return (
    <div className="guide">
      <ChapterRail
        chapters={chapters}
        index={index}
        reviewedChapters={human.chapters}
        files={chapterFiles}
        onReviewed={(r) => onReviewed(chapter.id, r)}
        onSelect={onSelect}
      />
      <div className="guide-files">
        {chapterFiles.map((f) => (
          <FileDiff key={f.path} file={f} />
        ))}
        {next && (
          <button
            className="next-chapter card"
            onClick={() => onSelect(index + 1)}
          >
            <span className="muted small">
              Next chapter · {pad2(index + 2)}
            </span>
            <span className="next-chapter-title">
              {next.title}
              <ArrowRight size={14} />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
