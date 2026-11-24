/**
 * Lightweight, zero-dependency, XSS-safe Markdown renderer for LilaS UI.
 * Escapes all raw HTML before formatting headings, lists, blockquotes,
 * tables, inline code, links, bold/italic, and fenced code blocks.
 */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(raw) {
  let s = escapeHtml(raw);

  // Protect inline code spans first
  const codeSpans = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code class="md-inline-code">${code}</code>`);
    return `\u0000C${idx}\u0000`;
  });

  // Links [label](url) - allow http/https only
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    return `<a class="md-link" href="${url}" data-ext-url="${url}">${label}</a>`;
  });

  // Bold & italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  // Restore inline code spans
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => codeSpans[Number(i)] || "");
  return s;
}

export function renderMarkdown(text) {
  if (!text) return "";
  const src = String(text).replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      const rawCode = codeLines.join("\n");
      const escapedCode = escapeHtml(rawCode);
      const b64 = encodeURIComponent(rawCode);
      out.push(
        `<div class="md-code-wrap"><div class="md-code-head"><span class="md-code-lang">${escapeHtml(
          lang || "code",
        )}</span><button type="button" class="mini-copy" data-copy-raw="${escapeHtml(
          b64,
        )}">复制</button></div><pre class="md-pre"><code>${escapedCode}</code></pre></div>`,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push('<hr class="md-hr" />');
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${renderInline(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="md-quote">${qLines.map(renderInline).join("<br/>")}</blockquote>`);
      continue;
    }

    // Table (header | sep | rows)
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const splitRow = (r) =>
        r
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (r) =>
            `<tr>${headers.map((_, idx) => `<td>${renderInline(r[idx] ?? "")}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody>`;
      out.push(`<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(
        `<ul class="md-list">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        `<ol class="md-list">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`,
      );
      continue;
    }

    // Paragraph (coalesce consecutive plain lines)
    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i++;
    }
    out.push(`<p class="md-p">${pLines.map(renderInline).join("<br/>")}</p>`);
  }

  return out.join("");
}
