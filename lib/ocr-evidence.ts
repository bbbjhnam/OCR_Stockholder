import type { ParsedRegister } from "./register-parser";

export function hasTargetHolding(evidence: ParsedRegister | null | undefined) {
  return evidence !== null && evidence !== undefined
    && evidence.nameMatch !== "실패" && evidence.owned !== null;
}

export function shouldSupplementDigitalText(options: {
  precise: boolean;
  hasEnoughText: boolean;
  corruptTextLayer: boolean;
  targetAnchorSeen: boolean;
  parsed: ParsedRegister;
}) {
  const complete = hasTargetHolding(options.parsed)
    && options.parsed.total !== null && options.parsed.holdings.length > 0;
  if (!options.hasEnoughText) return true;
  if (options.corruptTextLayer && !complete) return true;
  // A summary register without the requested shareholder is not an OCR error.
  // Only refine a readable digital layer when it actually contains the target.
  return options.precise && options.targetAnchorSeen && !complete;
}

export function selectPrecisionRecoveryPages(pages: Array<{
  pageNumber: number;
  targetAnchorSeen: boolean;
  targetNameMatched?: boolean;
  score: number;
}>) {
  const matched = pages.filter((page) => page.targetNameMatched);
  const anchored = matched.length ? matched : pages.filter((page) => page.targetAnchorSeen);
  const first = pages.find((page) => page.pageNumber === 1);
  const best = [...pages].sort((left, right) => right.score - left.score)[0];
  // Read every page once before spending time on a difficult row. Target pages
  // get one alternate layout pass. If no target is visible yet, the first page
  // and strongest candidate retain automatic-layout recovery without retrying
  // every page in several modes.
  return [...new Set([
    ...anchored.map((page) => page.pageNumber),
    ...(!anchored.length && first ? [first.pageNumber] : []),
    ...(!anchored.length && best ? [best.pageNumber] : []),
  ])].slice(0, 3);
}

export function selectOrientationRecoveryPage(pages: Array<{
  pageNumber: number;
  targetAnchorSeen: boolean;
  score: number;
  text: string;
}>) {
  if (pages.some((page) => page.targetAnchorSeen
    || /주주명|주식수|보통주|우선주|합계|총계/.test(page.text.replace(/\s/g, "")))) return null;
  return [...pages].sort((left, right) => right.score - left.score)[0]?.pageNumber ?? null;
}

function evidenceScore(candidate: ParsedRegister) {
  if (candidate.nameMatch === "실패" || candidate.owned === null || !candidate.holdings.length) return Number.NEGATIVE_INFINITY;
  if (candidate.holdings.some((holding) => holding.shareClass === "주식종류 미표시" || holding.shares <= 0)) {
    return Number.NEGATIVE_INFINITY;
  }

  // Stock classes are independent evidence. A candidate that preserves two
  // target rows is stronger than a superficially high-confidence candidate
  // that attached the next shareholder's single row to the target name.
  return candidate.holdings.length * 50
    + (candidate.nameMatch === "정확" ? 20 : 10)
    + (candidate.confidence === "높음" ? 20 : candidate.confidence === "보통" ? 5 : -10);
}

export function selectCanonicalTargetEvidence(candidates: Array<ParsedRegister | null | undefined>) {
  return candidates
    .filter((candidate): candidate is ParsedRegister => candidate !== null && candidate !== undefined)
    .map((candidate) => ({ candidate, score: evidenceScore(candidate) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score
      || right.candidate.holdings.length - left.candidate.holdings.length
      || Number(right.candidate.nameMatch === "정확") - Number(left.candidate.nameMatch === "정확")
      || Number(right.candidate.confidence === "높음") - Number(left.candidate.confidence === "높음"))[0]?.candidate ?? null;
}

export function buildCanonicalTargetBlock(target: string, evidence: ParsedRegister | null) {
  if (!evidence?.holdings.length) return "";
  return evidence.holdings.map((holding, index) =>
    `${index === 0 ? `${target} ` : ""}${holding.shareClass} ${holding.shares}주`).join("\n");
}
