import { closesCodeFence, splitLines } from '@markroot/document';

/**
 * Replaces Markdown HTML comments with whitespace while preserving length and
 * line endings. Literal comment syntax inside inline or fenced code is kept.
 */
export function maskMarkdownHtmlComments(source: string): string {
  const lines = splitLines(source);
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let inlineTicks = 0;
  let inComment = false;
  let output = '';

  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!inComment && inlineTicks === 0 && fence) {
      output += line;
      if (closesCodeFence(line, fence)) fence = undefined;
      continue;
    }
    if (!inComment && inlineTicks === 0 && fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length };
      output += line;
      continue;
    }

    for (let index = 0; index < line.length;) {
      if (inComment) {
        if (line.startsWith('-->', index)) {
          output += '   ';
          index += 3;
          inComment = false;
        } else {
          const character = line[index]!;
          output += character === '\n' || character === '\r' ? character : ' ';
          index += 1;
        }
        continue;
      }
      if (line[index] === '`') {
        let end = index + 1;
        while (line[end] === '`') end += 1;
        const run = end - index;
        if (inlineTicks === 0) inlineTicks = run;
        else if (run === inlineTicks) inlineTicks = 0;
        output += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineTicks === 0 && line.startsWith('<!--', index)) {
        output += '    ';
        index += 4;
        inComment = true;
        continue;
      }
      output += line[index]!;
      index += 1;
    }
  }
  return output;
}

