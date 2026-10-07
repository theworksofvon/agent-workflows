const KINDS: Record<string, [label: string, tone: string]> = {
  ts: ["TS", "ts"],
  tsx: ["TS", "ts"],
  mts: ["TS", "ts"],
  js: ["JS", "js"],
  jsx: ["JS", "js"],
  mjs: ["JS", "js"],
  cjs: ["JS", "js"],
  json: ["{}", "json"],
  md: ["MD", "md"],
  mdx: ["MD", "md"],
  sql: ["SQL", "sql"],
  yml: ["YML", "yml"],
  yaml: ["YML", "yml"],
  toml: ["TML", "yml"],
  py: ["PY", "py"],
  go: ["GO", "go"],
  rs: ["RS", "rs"],
  css: ["CSS", "css"],
  scss: ["CSS", "css"],
  html: ["<>", "html"],
  sh: ["SH", "sh"],
  swift: ["SW", "rs"],
  kt: ["KT", "py"],
};

/** A small letter badge for the file type, in the style of an editor tab. */
export function FileIcon({ path }: { path: string }) {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const [label, tone] = name.startsWith(".env")
    ? ["ENV", "sh"]
    : (KINDS[ext] ?? ["", "plain"]);
  return (
    <span className={`file-icon file-icon-${tone}`} aria-hidden>
      {label}
    </span>
  );
}
