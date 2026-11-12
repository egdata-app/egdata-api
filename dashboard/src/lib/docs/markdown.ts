export type DocHeading = {
  id: string;
  depth: number;
  text: string;
};

export type RenderedMarkdown = {
  html: string;
  headings: DocHeading[];
};

export type ParsedDocument = {
  title?: string;
  description?: string;
  markdown: string;
};

/** Strip the small YAML frontmatter block used by copied docs sources. */
export function parseFrontmatter(source: string): ParsedDocument {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { markdown: source };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) data[key] = value;
  }

  return {
    title: data.title,
    description: data.description,
    markdown: source.slice(match[0].length),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, "")).trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Render the small Markdown subset used by the copied documentation. Keeping
 * this local avoids a runtime dependency and never accepts untrusted HTML.
 */
export function renderMarkdown(markdown: string): RenderedMarkdown {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings: DocHeading[] = [];
  const used = new Map<string, number>();
  let index = 0;
  let html = "";

  const heading = (depth: number, text: string) => {
    const content = inline(text);
    const plain = stripTags(content);
    const base = slugify(plain) || "section";
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    headings.push({ id, depth, text: plain });
    return `<h${depth} id="${id}">${content}</h${depth}>`;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index++;
      }
      index++;
      html += `<pre><code${language ? ` class="language-${language}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      html += heading(headingMatch[1].length, headingMatch[2]);
      index++;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      html += "<hr>";
      index++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index++;
      }
      html += `<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`;
      continue;
    }

    if (isTableStart(lines, index)) {
      const result = renderTable(lines, index);
      html += result.html;
      index = result.next;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const result = renderList(lines, index);
      html += result.html;
      index = result.next;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const result = renderList(lines, index);
      html += result.html;
      index = result.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim() || isBlockStart(lines, index)) break;
      paragraph.push(next.trim());
      index++;
    }
    if (paragraph.length > 0) {
      html += `<p>${inline(paragraph.join(" "))}</p>`;
    }
  }

  return { html, headings };
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    /^\s*```/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    /^\s*---+\s*$/.test(line) ||
    /^\s*>\s?/.test(line) ||
    isTableStart(lines, index) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index++;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index];
  const next = lines[index + 1];
  if (!line?.includes("|") || !next?.includes("|")) return false;
  const cells = splitTableRow(next);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replaceAll(" ", "")))
  );
}

function renderTable(
  lines: string[],
  start: number,
): { html: string; next: number } {
  const header = splitTableRow(lines[start]);
  let index = start + 2;
  const rows: string[][] = [];
  while (index < lines.length && lines[index].includes("|")) {
    if (!lines[index].trim()) break;
    rows.push(splitTableRow(lines[index]));
    index++;
  }
  const head = header.map((cell) => `<th>${inline(cell)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${header
          .map((_, cellIndex) => `<td>${inline(row[cellIndex] ?? "")}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return {
    html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
    next: index,
  };
}

function renderList(
  lines: string[],
  start: number,
): { html: string; next: number } {
  const first = lines[start].match(/^(\s*)([-*]|\d+\.)\s+/);
  const baseIndent = first?.[1].length ?? 0;
  const ordered = /^\s*\d+\.\s+/.test(lines[start]);
  const items: string[] = [];
  let index = start;

  while (index < lines.length) {
    const match = lines[index].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (!match || match[1].length !== baseIndent) break;

    const itemOrdered = /^\d+\./.test(match[2]);
    if (itemOrdered !== ordered) break;

    let content = match[3];
    let nestedHtml = "";
    index++;

    while (index < lines.length) {
      if (!lines[index].trim()) {
        let lookahead = index + 1;
        while (lookahead < lines.length && !lines[lookahead].trim()) {
          lookahead++;
        }
        const nextItem = lines[lookahead]?.match(/^(\s*)([-*]|\d+\.)\s+/);
        const nextOrdered = nextItem ? /^\d+\./.test(nextItem[2]) : false;
        if (
          nextItem &&
          nextItem[1].length >= baseIndent &&
          nextOrdered === ordered
        ) {
          index = lookahead;
        }
        break;
      }

      const nested = lines[index].match(/^(\s*)([-*]|\d+\.)\s+/);
      if (nested) {
        if (nested[1].length <= baseIndent) break;
        const result = renderList(lines, index);
        nestedHtml += result.html;
        index = result.next;
        continue;
      }

      const continuationIndent = lines[index].match(/^\s*/)?.[0].length ?? 0;
      if (continuationIndent > baseIndent) {
        content += ` ${lines[index].trim()}`;
        index++;
        continue;
      }
      break;
    }

    items.push(`<li>${inline(content)}${nestedHtml}</li>`);
  }

  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: index };
}

function inline(value: string): string {
  const code: string[] = [];
  let text = escapeHtml(value).replace(/`([^`]+)`/g, (_match, content) => {
    code.push(content);
    return `\uE000${code.length - 1}\uE000`;
  });

  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return text.replace(/\uE000(\d+)\uE000/g, (_match, token: string) => {
    return `<code>${code[Number(token)]}</code>`;
  });
}
