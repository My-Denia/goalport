// Escape-by-construction markdown-lite renderer.
//
// Rendering safety contract:
// - Output is built ONLY from React elements and text nodes; React escapes all
//   literal text, so HTML/script payloads in timeline bodies render inert.
// - No dangerouslySetInnerHTML anywhere in this module.
// - No new rendering dependency.
// - Links are rendered as anchors only for http/https targets; every other
//   scheme (javascript:, data:, file:, unknown) renders as plain text.
import { useState, type ReactNode } from "react";

const FENCE = /^```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const LIST_ITEM = /^[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\d+[.)]\s+(.*)$/;
const INLINE_TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE_TOKEN.lastIndex = 0;
  let index = 0;
  while ((match = INLINE_TOKEN.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = linkMatch?.[1] ?? token;
      const href = linkMatch ? safeHref(linkMatch[2]) : null;
      if (href) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="md-code-block">
      <div className="md-code-bar">
        <span>{language || "code"}</span>
        <button type="button" className="md-copy" onClick={() => { void copy(); }} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="md-code-pre"><code>{code}</code></pre>
    </div>
  );
}

/**
 * Renders a timeline message body as markdown-lite.
 * Supported: fenced code blocks, `- ` / `* ` / `1. ` lists, `#`–`###` headings,
 * paragraphs, inline code / bold / italic / [label](http…https links).
 * Everything that is not one of those shapes renders as inert escaped text.
 */
export function renderMarkdownBody(body: string, keyPrefix: string): ReactNode[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n");
    blocks.push(<p key={`${keyPrefix}-p${index++}`}>{renderInline(text, `${keyPrefix}-p${index}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, itemIndex) => (
      <li key={`${keyPrefix}-l${index}-${itemIndex}`}>{renderInline(item, `${keyPrefix}-li${index}-${itemIndex}`)}</li>
    ));
    blocks.push(
      list.ordered
        ? <ol key={`${keyPrefix}-ol${index++}`}>{items}</ol>
        : <ul key={`${keyPrefix}-ul${index++}`}>{items}</ul>
    );
    list = null;
  };

  while (lines.length > 0) {
    const line = lines.shift() as string;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      const language = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      while (lines.length > 0 && !FENCE.test(lines[0] as string)) codeLines.push(lines.shift() as string);
      lines.shift(); // closing fence, or EOF
      blocks.push(<CodeBlock key={`${keyPrefix}-c${index++}`} code={codeLines.join("\n")} language={language} />);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2], `${keyPrefix}-h${index}`);
      blocks.push(
        level === 1 ? <h4 key={`${keyPrefix}-h${index++}`}>{content}</h4>
          : level === 2 ? <h5 key={`${keyPrefix}-h${index++}`}>{content}</h5>
            : <h6 key={`${keyPrefix}-h${index++}`}>{content}</h6>
      );
      continue;
    }
    const bullet = LIST_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const item = (bullet ?? ordered)?.[1] ?? "";
      const wantOrdered = Boolean(ordered);
      if (!list || list.ordered !== wantOrdered) {
        flushList();
        list = { ordered: wantOrdered, items: [] };
      }
      list.items.push(item);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}
