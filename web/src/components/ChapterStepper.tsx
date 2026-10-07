import { chapterProgressLabel } from "../lib/orientation";
import { pad2 } from "../lib/format";
import type { GuideChapter } from "../types";

/** One segment per chapter: filled when reviewed, ringed when current. */
export function ChapterStepper({
  chapters,
  index,
  reviewed,
  onSelect,
}: {
  chapters: GuideChapter[];
  index: number;
  reviewed: Record<string, boolean>;
  onSelect: (index: number) => void;
}) {
  const done = chapters.filter((c) => reviewed[c.id]).length;
  return (
    <div className="stepper">
      <div className="stepper-label">
        {chapterProgressLabel(index, chapters.length, done)}
      </div>
      <ol className="stepper-track" aria-label="Chapters">
        {chapters.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              className={`step ${reviewed[c.id] ? "is-done" : ""} ${i === index ? "is-current" : ""}`}
              title={`${pad2(i + 1)} · ${c.title}${reviewed[c.id] ? " (reviewed)" : ""}`}
              aria-label={`Chapter ${i + 1}: ${c.title}`}
              aria-current={i === index ? "step" : undefined}
              onClick={() => onSelect(i)}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
