import { Fragment, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

function safeLink(href: string) {
  if (/^#[^\s]*$/.test(href) || /^\/(?![\/\\])[^\\\s]*$/.test(href)) return href;
  try {
    const url = new URL(href);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

function renderTokens(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>);
}

function renderToken(token: Token): ReactNode {
  switch (token.type) {
    case 'space':
    case 'html':
    case 'def': return null;
    case 'br': return <br />;
    case 'hr': return <hr />;
    case 'escape':
    case 'image': return token.text;
    case 'text': return token.tokens ? renderTokens(token.tokens) : token.text;
    case 'strong': return <strong>{renderTokens(token.tokens)}</strong>;
    case 'em': return <em>{renderTokens(token.tokens)}</em>;
    case 'del': return <del>{renderTokens(token.tokens)}</del>;
    case 'codespan': return <code>{token.text}</code>;
    case 'code': return <pre><code>{token.text}</code></pre>;
    case 'paragraph': return <p>{renderTokens(token.tokens)}</p>;
    case 'blockquote': return <blockquote>{renderTokens(token.tokens)}</blockquote>;
    case 'heading': {
      const levels = ['h2', 'h3', 'h4', 'h5', 'h6', 'h6'] as const;
      const Heading = levels[(token as Tokens.Heading).depth - 1] ?? 'h6';
      return <Heading>{renderTokens(token.tokens)}</Heading>;
    }
    case 'link': {
      const href = safeLink(token.href);
      const text = renderTokens(token.tokens);
      return href ? <a className="ep-link" href={href} rel="noreferrer noopener">{text}</a> : text;
    }
    case 'list': {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => <li key={index}>
        {item.task && <input type="checkbox" checked={Boolean(item.checked)} disabled aria-label={item.checked ? '已完成' : '未完成'} />}
        {renderTokens(item.tokens)}
      </li>);
      return list.ordered ? <ol start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': {
      const table = token as Tokens.Table;
      return <div className="dw-notes-table" role="region" aria-label="文档表格" tabIndex={0}>
        <table><thead><tr>{table.header.map((cell, column) =>
          <th scope="col" key={column}>{renderTokens(cell.tokens)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) =>
            <td key={column}>{renderTokens(cell.tokens)}</td>)}</tr>)}</tbody></table>
      </div>;
    }
    default: return null;
  }
}

export function ReadableNotes({ source }: { source: string }) {
  return <div className="dw-notes">{renderTokens(marked.lexer(source))}</div>;
}

export function InlineDesignNotes({ source }: { source: string }) {
  return <>{renderTokens(marked.Lexer.lexInline(source))}</>;
}
