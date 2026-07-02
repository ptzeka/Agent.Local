// Stable edge-endpoint ids: entities must be nameable before they can be related,
// and the same source construct must always yield the same id across snapshots.

import type { ParserLanguage } from './types.js';

export function symbolId(path: string, symbol: string, parentSymbol: string | null = null): string {
  return parentSymbol ? `${path}#${parentSymbol}.${symbol}` : `${path}#${symbol}`;
}

// a relative specifier resolves lexically to a repo path (no fs probing — the indexer
// may run on content alone); anything else is an external module
export function importTargetId(fromPath: string, specifier: string, language: ParserLanguage): string {
  if (!specifier.startsWith('.')) return `external:${specifier}`;
  const resolved = normalizePosix(`${posixDirname(fromPath)}/${specifier}`);
  return isTypeScript(language) ? withTsSourceExtension(resolved) : resolved;
}

// ESM import specifiers in this repo say `.js` while the entity on disk is the `.ts`
// source — rewrite so import edges join against indexed file ids
function withTsSourceExtension(path: string): string {
  return path.replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts');
}

function isTypeScript(language: ParserLanguage): boolean {
  return language === 'typescript' || language === 'tsx';
}

function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}

function normalizePosix(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}
