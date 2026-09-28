import type { ParsedRegister } from "./register-parser";

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
