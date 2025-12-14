export interface SuggestionPattern {
  fullMatch: string;
  text: string;
  startIndex: number;
  endIndex: number;
}

export function detectSuggestionPattern(
  text: string,
): SuggestionPattern | null {
  const pattern = /\{\{suggestion:\s*((?:(?!\}\}).)+)\}\}/;
  const match = text.match(pattern);
  if (!match || match.index === undefined || !match[1]) return null;

  return {
    fullMatch: match[0],
    text: match[1].trim(),
    startIndex: match.index,
    endIndex: match.index + match[0].length,
  };
}

export function isSuggestionPattern(text: string): boolean {
  return detectSuggestionPattern(text) !== null;
}

export function extractSuggestionText(text: string): string | null {
  const pattern = detectSuggestionPattern(text);
  return pattern?.text ?? null;
}

export function validateSuggestionElement(
  element: Element,
  text: string,
): boolean {
  const pattern = /\{\{suggestion:\s*((?:(?!\}\}).)+)\}\}/;
  const patternMatch = text.match(pattern);
  if (!patternMatch || patternMatch.index === undefined) return false;

  const beforePattern = text.substring(0, patternMatch.index).trim();
  const afterPattern = text
    .substring(patternMatch.index + patternMatch[0].length)
    .trim();

  const _hasMinimalPrefix =
    beforePattern.length === 0 || /^[•\-*\d+.)]\s*$/.test(beforePattern);
  const hasMinimalSuffix = afterPattern.length === 0 || afterPattern.length < 5;

  return hasMinimalSuffix;
}
