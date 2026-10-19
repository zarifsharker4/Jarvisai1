import { type ReactNode } from 'react';

/**
 * Small dependency-free markdown renderer. Everything becomes React elements
 * (never raw HTML), so model output cannot inject markup.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\n]+\*)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const k = `${keyBase}-${key++}`;
    if (token.startsWith('**')) {
      nodes.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={k} className="inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push(
          <a key={k} href={linkMatch[2]} target="_blank" rel="noreferrer noopener">
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(<em key={k}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { type: 'code'; lang: string; body: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'paragraph'; lines: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push({ type: 'code', lang, body: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }
    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: quoted.join(' ') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !lines[i].startsWith('>')
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', lines: para });
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text ?? '');
  return (
    <div className="md">
      {blocks.map((block, idx) => {
        const key = `b${idx}`;
        switch (block.type) {
          case 'code':
            return (
              <pre key={key} className="code-block" data-lang={block.lang || 'code'}>
                <code>{block.body}</code>
              </pre>
            );
          case 'heading': {
            const Tag = (['h4', 'h4', 'h3', 'h2'] as const)[Math.min(block.level, 4) - 1] ?? 'h4';
            return <Tag key={key}>{inline(block.text, key)}</Tag>;
          }
          case 'list':
            return block.ordered ? (
              <ol key={key} className="md-list">
                {block.items.map((item, itemIdx) => (
                  <li key={`${key}-${itemIdx}`}>{inline(item, `${key}-${itemIdx}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="md-list">
                {block.items.map((item, itemIdx) => (
                  <li key={`${key}-${itemIdx}`}>{inline(item, `${key}-${itemIdx}`)}</li>
                ))}
              </ul>
            );
          case 'quote':
            return <blockquote key={key}>{inline(block.text, key)}</blockquote>;
          default:
            return (
              <p key={key}>
                {block.lines.map((line, lineIdx) => (
                  <span key={`${key}-${lineIdx}`}>
                    {inline(line, `${key}-${lineIdx}`)}
                    {lineIdx < block.lines.length - 1 ? <br /> : null}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
