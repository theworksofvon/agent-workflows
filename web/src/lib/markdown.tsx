import { Fragment, type ReactNode } from "react";

/**
 * Light markdown: paragraphs on blank lines, line breaks, `code` spans and
 * **bold**. Agent and guide text use little else, and anything richer would
 * need an HTML sanitizer.
 */
export function Markdown({ text }: { text: string }) {
  const paragraphs = text.trim().split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i}>
          {p.split("\n").map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              <Inline text={line} />
            </Fragment>
          ))}
        </p>
      ))}
    </>
  );
}

export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      out.push(<code key={match.index}>{match[1]}</code>);
    } else {
      out.push(<strong key={match.index}>{match[2]}</strong>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
