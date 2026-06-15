import type { RecallResult, RecalledMemory } from '../memory/types.js';

// renders recall output: core records first (always-loaded salience), then archival ranked by similarity
export function formatRecall(result: RecallResult): string {
  const header = `collection: ${result.collection} · core: ${result.core.length} · archival: ${result.archival.length}`;
  if (result.core.length === 0 && result.archival.length === 0) {
    return `${header}\n(no memories matched)`;
  }
  const sections: string[] = [header];
  if (result.core.length > 0) {
    sections.push('# core\n' + result.core.map((m) => formatMemory(m)).join('\n'));
  }
  if (result.archival.length > 0) {
    sections.push('# archival\n' + result.archival.map((m) => formatMemory(m)).join('\n'));
  }
  return sections.join('\n\n');
}

function formatMemory(memory: RecalledMemory): string {
  const meta = memory.metadata;
  const tagBits = [
    meta.category ? `category=${meta.category}` : '',
    meta.tenant ? `tenant=${meta.tenant}` : '',
    meta.tags && meta.tags.length > 0 ? `tags=${meta.tags.join(',')}` : '',
    meta.source ? `source=${meta.source}` : '',
    memory.score !== undefined ? `score=${memory.score.toFixed(4)}` : '',
  ].filter((s) => s.length > 0);
  const suffix = tagBits.length > 0 ? ` [${tagBits.join(' · ')}]` : '';
  return `- (${memory.id}) ${memory.content}${suffix}`;
}
