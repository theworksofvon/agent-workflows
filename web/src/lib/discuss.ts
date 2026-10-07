/**
 * Puts the lines that a T3 thread needs to load the `guided-review` skill
 * in front of the server's prompt: the skill name, the app's base URL, and
 * the session id. Without the skill, the rest of the prompt still stands alone.
 */
export function withSkillHeader(
  origin: string,
  sessionId: string,
  prompt: string,
): string {
  return [
    `Use the guided-review skill. App: ${origin} · session: ${sessionId}`,
    "",
    prompt,
  ].join("\n");
}
