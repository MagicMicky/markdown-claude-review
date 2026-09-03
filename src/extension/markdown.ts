import MarkdownIt from 'markdown-it';
// The common bundle (~35 languages) rather than all ~190: the full package
// adds well over a megabyte to the extension for languages a policy document
// will never contain. Unknown languages fall back to plain text, exactly as
// they would if highlight.js did not recognise them.
import hljs from 'highlight.js/lib/common';
import type { BlockRange } from '../core/rendermap.js';
import { blockRange, lineOffsets } from '../core/rendermap.js';
import type { PreviewSettings } from './config.js';

/**
 * Markdown rendering for the comment preview.
 *
 * Deliberately mirrors VS Code's built-in preview so the two look and behave
 * the same: markdown-it 12 (the version the built-in bundles — 14 renamed inline
 * rules and would drift), the same options, the same highlight.js alias map, and
 * the same `data-line` / `code-line` source-map convention.
 *
 * One deliberate difference: the built-in emits only `token.map[0]`, a start
 * line. We emit the end line too, because mapping a rendered selection back to
 * source characters needs the block's real extent, and inferring it from the
 * next block's start breaks on nested and trailing blocks.
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
    for (const token of state.tokens) {
      if (!token.map || token.type === 'inline') continue;
      const [startLine, endLine] = token.map;
      const index = blocks.length;
      blocks.push({ index, ...blockRange(source, startLine, endLine, offsets) });
      token.attrSet('data-line', String(startLine));
      token.attrSet('data-line-end', String(endLine));
      token.attrSet('data-block', String(index));
      token.attrJoin('class', 'code-line');
      token.attrJoin('dir', 'auto');
    }
    return true;
  });

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
