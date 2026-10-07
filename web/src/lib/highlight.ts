import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import type { Hunk } from "./patch";

/**
 * `style` holds Shiki's CSS variables (`--shiki-light`, `--shiki-dark`, and
 * their font-style variants); styles.css picks one set by the `dark` class.
 */
export interface Token {
  content: string;
  style?: Record<string, string>;
}

/** Tokens per hunk, per line; parallel to `Hunk.lines`. */
export type HunkTokens = Token[][][];

const THEMES = { light: "github-light", dark: "github-dark" } as const;
// Above this many lines highlighting costs more than it helps.
const MAX_HIGHLIGHT_LINES = 4000;

// Explicit imports so the build ships only these grammars, each lazily.
const LANGS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
};

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  css: "css",
  scss: "scss",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",
  xml: "xml",
  ini: "ini",
  tf: "hcl",
  hcl: "hcl",
  lua: "lua",
  ex: "elixir",
  exs: "elixir",
  dart: "dart",
  scala: "scala",
  zig: "zig",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  ".env": "dotenv",
  ".env.example": "dotenv",
};

/** Shiki language id for a path, or null for plain text. */
export function languageFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith(".env")) return "dotenv";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({
      themes: [
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }),
  );
  return highlighter;
}

/**
 * Highlight a file's hunks. The old side (context + deleted lines) and the
 * new side (context + added lines) are tokenized as two separate texts, so
 * multi-line constructs stay correct on each side. Returns null when the
 * language is unknown or the file is too large.
 */
export async function highlightHunks(
  path: string,
  hunks: Hunk[],
): Promise<HunkTokens | null> {
  const lang = languageFor(path);
  const loader = lang ? LANGS[lang] : undefined;
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  if (!lang || !loader || total === 0 || total > MAX_HIGHLIGHT_LINES) return null;

  const hl = await getHighlighter();
  try {
    await hl.loadLanguage((await loader()).default);
  } catch {
    return null;
  }

  const oldText: string[] = [];
  const newText: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "add") oldText.push(line.text);
      if (line.kind !== "del") newText.push(line.text);
    }
  }
  const tokenize = (lines: string[]): Token[][] =>
    hl
      .codeToTokens(lines.join("\n"), {
        lang,
        themes: THEMES,
        defaultColor: false,
      })
      .tokens.map((line) =>
        line.map((t) => ({ content: t.content, style: t.htmlStyle })),
      );
  let oldTokens: Token[][];
  let newTokens: Token[][];
  try {
    oldTokens = tokenize(oldText);
    newTokens = tokenize(newText);
  } catch {
    // A grammar the JavaScript regex engine cannot run: show plain text.
    return null;
  }

  let o = 0;
  let n = 0;
  return hunks.map((hunk) =>
    hunk.lines.map((line) => {
      if (line.kind === "del") return oldTokens[o++] ?? [];
      if (line.kind === "add") return newTokens[n++] ?? [];
      o += 1;
      return newTokens[n++] ?? [];
    }),
  );
}
