import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';
// The common bundle (~35 languages) rather than all ~190: the full package
// adds well over a megabyte to the extension for languages a policy document
// will never contain. Unknown languages fall back to plain text, exactly as
// they would if highlight.js did not recognise them.
import hljs from 'highlight.js/lib/common';
import type { BlockRange } from '../core/rendermap.js';
import { blockRange, lineOffsets } from '../core/rendermap.js';

/** The `markdown.preview.*` settings that affect rendering. */
export interface PreviewSettings {
  breaks: boolean;
  linkify: boolean;
  typographer: boolean;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  scrollPreviewWithEditor: boolean;
  scrollEditorWithPreview: boolean;
  markEditorSelection: boolean;
  doubleClickToSwitchToEditor: boolean;
  /** User stylesheets from `markdown.styles`. */
  styles: string[];
}

/**
 * Markdown rendering for the comment preview.
 *
 * Deliberately mirrors VS Code's built-in preview so the two look and behave
 * the same: markdown-it 12 (the version the built-in bundles — 14 renamed inline
 * rules and would drift), the same options, the same highlight.js alias map, and
 * the same `data-line` / `code-line` source-map convention.
 *
 * Two deliberate differences from the built-in, both so that rendered text can
 * be mapped back to source characters:
 *
 *  - `data-line-end` alongside `data-line`, because a block's real extent
 *    cannot be inferred from the next block's start (nested and trailing
 *    blocks break that).
 *  - every run of rendered text is wrapped in a span carrying the source
 *    offsets it came from. Those offsets are taken from markdown-it's own token
 *    stream, so nothing downstream has to guess which characters were markup —
 *    guessing is what made highlights vanish on tables, code, entities and
 *    `snake_case` identifiers.
 */

/** The built-in preview's language aliases, so fences highlight identically. */
const LANGUAGE_ALIASES: Record<string, string> = {
  shell: 'sh',
  py3: 'python',
  tsx: 'jsx',
  typescriptreact: 'jsx',
  json5: 'json',
  jsonc: 'json',
  'c#': 'cs',
  csharp: 'cs',
};

function highlight(code: string, lang: string): string {
  const name = LANGUAGE_ALIASES[lang?.toLowerCase()] ?? lang;
  if (name && hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch {
      /* fall through to plain text */
    }
  }
  return '';
}

/** GitHub-style heading slugs, matching the built-in preview's anchors. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\]\[!/'"#$%&()*+,./:;<=>?@\\^{|}~`-]/g, '')
    .replace(/\s+/g, '-');
}

export interface RenderedBlock extends BlockRange {
  /** Index in document order, used as the webview's handle for the block. */
  index: number;
}

export interface Rendered {
  html: string;
  blocks: RenderedBlock[];
}

/** Class on every span carrying source offsets. */
export const TEXT_RUN_CLASS = 'mdr-run';

/**
 * Attach source offsets to the inline tokens of one block.
 *
 * Inline tokens carry no position of their own, so walk them in order against
 * the block's source with a cursor. A token whose content cannot be found —
 * entities, backslash escapes, typographer substitutions all rewrite it — is
 * simply left unannotated: that fragment is then not highlightable, which is a
 * far better failure than annotating it wrongly.
 */
/**
 * Locate content that markdown-it rewrote on its way out of the source.
 *
 * `&amp;` becomes `&`, `\\*` becomes `*`, and the content then no longer appears
 * verbatim. Walk the two in step, allowing the source to spend an entity or an
 * escape where the content spends one character.
 */
function tolerantSpan(slice: string, content: string, from: number): [number, number] | null {
  const first = content[0];
  for (let start = from; start < slice.length; start++) {
    const c = slice[start];
    if (c !== first && c !== '&' && c !== '\\') continue;
    let i = start;
    let j = 0;
    while (i < slice.length && j < content.length) {
      // The entity check must come first. `&amp;` renders as `&`, and matching
      // the bare `&` on plain equality consumes one character where the source
      // spent five, so the two walks desync and the whole run is lost.
      if (slice[i] === '&') {
        const semi = slice.indexOf(';', i + 1);
        if (semi !== -1 && semi - i <= 10 && /^[a-z0-9#]+$/i.test(slice.slice(i + 1, semi))) {
          i = semi + 1;
          j++;
          continue;
        }
      }
      if (slice[i] === content[j]) {
        i++;
        j++;
        continue;
      }
      if (slice[i] === '\\' && slice[i + 1] === content[j]) {
        i += 2;
        j++;
        continue;
      }
      break;
    }
    if (j === content.length) return [start, i];
  }
  return null;
}

function annotateInline(token: Token, source: string, blockStart: number, blockEnd: number): void {
  const slice = source.slice(blockStart, blockEnd);
  let cursor = 0;
  for (const child of token.children ?? []) {
    if (child.type === 'softbreak' || child.type === 'hardbreak') {
      const nl = slice.indexOf('\n', cursor);
      if (nl !== -1) cursor = nl + 1;
      continue;
    }
    const content = child.type === 'code_inline' ? child.content : child.content;
    if (child.type !== 'text' && child.type !== 'code_inline') continue;
    if (!content) continue;

    const at = slice.indexOf(content, cursor);
    const span: [number, number] | null =
      at !== -1 ? [at, at + content.length] : tolerantSpan(slice, content, cursor);
    if (!span) continue;
    child.meta = {
      ...(child.meta ?? {}),
      srcStart: blockStart + span[0],
      srcEnd: blockStart + span[1],
    };
    cursor = span[1];
  }
}

export interface RenderOptions {
  settings: PreviewSettings;
  /** Rewrites a relative image path into something the webview may load. */
  resolveImage?: (src: string) => string;
}

export function createEngine(settings: PreviewSettings): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    breaks: settings.breaks,
    linkify: settings.linkify,
    typographer: settings.typographer,
    highlight,
  });
  // The built-in disables fuzzy linkification; without this, bare words with
  // dots in prose ("modules/kms.tf") turn into links.
  md.linkify.set({ fuzzyLink: false });
  return md;
}

export function render(source: string, opts: RenderOptions): Rendered {
  const md = createEngine(opts.settings);
  const blocks: RenderedBlock[] = [];
  // Once for the document, not once per block.
  const offsets = lineOffsets(source);

  // Source-map attributes, applied last so nothing downstream strips them.
  md.core.ruler.push('mdreview_source_map', (state) => {
    let block: BlockRange | undefined;
    for (const token of state.tokens) {
      if (token.type === 'inline') {
        if (block) annotateInline(token, source, block.start, block.end);
        continue;
      }
      if (!token.map) continue;
      const [startLine, endLine] = token.map;
      const index = blocks.length;
      block = blockRange(source, startLine, endLine, offsets);
      blocks.push({ index, ...block });

      // A fence has no inline children, so annotate it as one run. Its content
      // is verbatim source, so the offsets are exact; a comment inside a code
      // block then highlights the block rather than nothing at all.
      if ((token.type === 'fence' || token.type === 'code_block') && token.content) {
        const at = source.indexOf(token.content, block.start);
        if (at !== -1 && at < block.end) {
          token.attrSet('data-o', String(at));
          token.attrSet('data-e', String(at + token.content.length));
        }
      }
      token.attrSet('data-line', String(startLine));
      token.attrSet('data-line-end', String(endLine));
      token.attrSet('data-block', String(index));
      token.attrJoin('class', 'code-line');
      token.attrJoin('dir', 'auto');
    }
    return true;
  });

  // Emit the offsets that annotateInline worked out.
  const run = (content: string, meta: { srcStart?: number; srcEnd?: number } | null): string => {
    if (meta?.srcStart === undefined) return content;
    return `<span class="${TEXT_RUN_CLASS}" data-o="${meta.srcStart}" data-e="${meta.srcEnd}">${content}</span>`;
  };
  md.renderer.rules.text = (tokens, idx) =>
    run(md.utils.escapeHtml(tokens[idx].content), tokens[idx].meta);
  const defaultCode = md.renderer.rules.code_inline;
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    const html = defaultCode
      ? defaultCode(tokens, idx, options, env, self)
      : `<code>${md.utils.escapeHtml(tokens[idx].content)}</code>`;
    return run(html, tokens[idx].meta);
  };

  // Heading anchors, as the built-in does.
  const defaultHeading = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const inline = tokens[idx + 1];
    if (inline?.type === 'inline') tokens[idx].attrSet('id', slugify(inline.content));
    return defaultHeading
      ? defaultHeading(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };

  // Relative images must be rewritten to a URI the webview is allowed to load.
  if (opts.resolveImage) {
    const defaultImage = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const src = token.attrGet('src');
      if (src) {
        token.attrSet('data-src', src);
        token.attrSet('src', opts.resolveImage!(src));
      }
      return defaultImage
        ? defaultImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
    };
  }

  const html = md.render(source);
  return { html, blocks };
}
