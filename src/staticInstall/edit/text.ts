export interface EditResult {
  /** Full new file content. */
  content: string;
  /** Just the added text, for the preview. */
  inserted: string;
}

export function splice(content: string, at: number, text: string): EditResult {
  return { content: content.slice(0, at) + text + content.slice(at), inserted: text };
}

export function lineBefore(content: string, pos: number): { lineStart: number; prefix: string } {
  const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
  return { lineStart, prefix: content.slice(lineStart, pos) };
}

export function indentOf(content: string, pos: number): string {
  const { prefix } = lineBefore(content, pos);
  return /^[ \t]*/.exec(prefix)![0];
}

/** Two spaces unless the file is clearly indented with tabs or four spaces. */
export function guessIndentUnit(content: string): string {
  const indents = content.match(/^[ \t]+(?=\S)/gm) ?? [];
  if (indents.filter((i) => i.startsWith('\t')).length > indents.length / 2) return '\t';
  const spaced = indents.filter((i) => !i.includes('\t')).map((i) => i.length);
  if (spaced.length > 0 && spaced.every((n) => n % 4 === 0)) return '    ';
  return '  ';
}

export function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? indent + line : line))
    .join('\n');
}
