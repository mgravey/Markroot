import { useEffect, useMemo, useState } from 'react';
import type { DocumentSnapshot } from '@markroot/document';
import type { SourceRange } from '@markroot/core';
import { DocumentStatisticsCalculator, type RenderCitation } from '@markroot/rendering';

/** One cache per open document, shared counts in the inspector and status bar. */
export function useDocumentStatistics(snapshot: DocumentSnapshot | undefined, selection: SourceRange, citations: readonly RenderCitation[], includeCaptions: boolean) {
  const path = snapshot?.path;
  const calculators = useMemo(() => ({ path, document: new DocumentStatisticsCalculator(), selection: new DocumentStatisticsCalculator() }), [path]);
  const [result, setResult] = useState<{
    path: string;
    document: ReturnType<DocumentStatisticsCalculator['calculate']>;
    selection: ReturnType<DocumentStatisticsCalculator['calculate']> | undefined;
  }>();
  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setTimeout(() => {
      const options = { citations, includeCaptions };
      setResult({ path: snapshot.path, document: calculators.document.calculate(snapshot, options), selection: selection.to > selection.from ? calculators.selection.calculate(snapshot, { ...options, selection: { from: selection.from, to: selection.to } }) : undefined });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [snapshot, selection.from, selection.to, citations, includeCaptions, calculators]);
  return result?.path === path ? result : undefined;
}
