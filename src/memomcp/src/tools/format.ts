import type { MemorySummary, RecallLocateResult, RecallResult, RecalledMemory } from '../memory/types.js';

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
  return `- (${memory.id}) ${memory.content}${metaSuffix(memory.metadata, memory.score, memory.rerankScore)}`;
}

// the locate tier: core summaries first, then archival ranked by score — content-free, with the
// vectorId an agent feeds back into recall_expand to pull the chosen bodies.
export function formatLocate(result: RecallLocateResult): string {
  const header = `collection: ${result.collection} · core: ${result.core.length} · archival: ${result.archival.length}`;
  if (result.core.length === 0 && result.archival.length === 0) {
    return `${header}\n(no memories matched)`;
  }
  const sections: string[] = [header];
  if (result.core.length > 0) {
    sections.push('# core\n' + result.core.map((s) => formatSummary(s)).join('\n'));
  }
  if (result.archival.length > 0) {
    sections.push('# archival\n' + result.archival.map((s) => formatSummary(s)).join('\n'));
  }
  return sections.join('\n\n');
}

function formatSummary(summary: MemorySummary): string {
  return `- (${summary.id}) vectorId=${summary.vectorId}${metaSuffix(summary.metadata, summary.score)}`;
}

// the expand tier: full memory bodies for the vectorIds an agent picked out of a locate
export function formatExpanded(memories: RecalledMemory[]): string {
  if (memories.length === 0) {
    return '(no memories found for the given ids)';
  }
  return memories.map((m) => formatMemory(m)).join('\n');
}

function metaSuffix(meta: RecalledMemory['metadata'], score?: number, rerankScore?: number): string {
  const tagBits = [
    meta.category ? `category=${meta.category}` : '',
    meta.tenant ? `tenant=${meta.tenant}` : '',
    meta.tags && meta.tags.length > 0 ? `tags=${meta.tags.join(',')}` : '',
    meta.source ? `source=${meta.source}` : '',
    score !== undefined ? `score=${score.toFixed(4)}` : '',
    rerankScore !== undefined ? `rerank=${rerankScore.toFixed(4)}` : '',
  ].filter((s) => s.length > 0);
  return tagBits.length > 0 ? ` [${tagBits.join(' · ')}]` : '';
}
