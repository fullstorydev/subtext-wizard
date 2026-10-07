import { type EditResult, guessIndentUnit, indentLines, indentOf, lineBefore, splice } from './text.js';

/** Put `snippetHtml` just before `</head>`, or undefined unless there's exactly one head. */
export function insertIntoHtmlHead(content: string, snippetHtml: string): EditResult | undefined {
  const opens = content.match(/<head[\s>]/gi) ?? [];
  const closes = content.match(/<\/head\s*>/gi) ?? [];
  if (opens.length !== 1 || closes.length !== 1) return undefined;

  const closeAt = content.search(/<\/head\s*>/i);
  const { lineStart, prefix } = lineBefore(content, closeAt);
  const closeIndent = indentOf(content, closeAt);
  const childIndent = closeIndent + guessIndentUnit(content);
  const block = indentLines(snippetHtml.trim(), childIndent);

  return /^\s*$/.test(prefix)
    ? splice(content, lineStart, `${block}\n`)
    : splice(content, closeAt, `\n${block}\n${closeIndent}`);
}
