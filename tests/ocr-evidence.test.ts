import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalTargetBlock, hasTargetHolding, selectCanonicalTargetEvidence, selectOrientationRecoveryPage, selectPrecisionRecoveryPages, shouldSupplementDigitalText } from "../lib/ocr-evidence.ts";
import { OCR_PAGE_BREAK, parseRegisterLines } from "../lib/register-parser.ts";

test("prefers a two-class target candidate over a misleading high-confidence neighbor row", () => {
  const misleading = {
    total: 16_397_076,
    holdings: [{ shareClass: "보통주", shares: 180_000 }],
    owned: 180_000,
    ratio: 1.1,
    matchedName: "엘앤에스 시스템반도체 상생 투자조합",
    nameMatch: "정확" as const,
    confidence: "높음" as const,
    note: "",
  };
  const twoClasses = {
    total: 910_222,
    holdings: [
      { shareClass: "보통주", shares: 61_729 },
      { shareClass: "상환전환우선주", shares: 129_938 },
    ],
    owned: 191_667,
    ratio: 21.06,
    matchedName: "엘앤에스 시스템반도체 상생 투자조합",
    nameMatch: "정확" as const,
    confidence: "확인 필요" as const,
    note: "",
  };

  const selected = selectCanonicalTargetEvidence([misleading, twoClasses]);
  assert.deepEqual(selected?.holdings, [
    { shareClass: "보통주", shares: 61_729 },
    { shareClass: "상환전환우선주", shares: 129_938 },
  ]);
});

test("canonical target block preserves holdings while later pages repair the total", () => {
  const target = "엘앤에스시스템반도체";
  const evidence = parseRegisterLines([
    `${target} 제4종 상환전환우선주 1,940 0.12%`,
  ], target);
  const canonical = buildCanonicalTargetBlock(target, evidence);
  const result = parseRegisterLines([
    canonical,
    OCR_PAGE_BREAK,
    "다른주주 제4종 상환전환우선주 4주",
    "다른주주 제5종 상환전환우선주 25주",
    "다른주주 보통주 40,000주 2.57%",
    "다른주주 보통주 30,442주 1.96%",
    "다른주주 보통주 58,195주 3.74%",
    "다른주주 보통주 238,000주 15.29%",
    "총합계 4,556,321 100.00%",
  ], target);

  assert.deepEqual(result.holdings, [{ shareClass: "제4종 상환전환우선주", shares: 1_940 }]);
  assert.equal(result.owned, 1_940);
  assert.equal(result.total, 1_556_321);
});

test("missing canonical evidence does not mean that target holdings were found", () => {
  assert.equal(hasTargetHolding(null), false);
  assert.equal(hasTargetHolding(undefined), false);
  assert.equal(hasTargetHolding(parseRegisterLines(["합계 1,099,940주"], "뮤렉스웨이브1호")), false);
});

test("precise digital recovery refines a target row but does not OCR an unrelated summary", () => {
  const target = "뮤렉스웨이브1호";
  const partial = parseRegisterLines([target, "합계 17,326주"], target);
  assert.equal(shouldSupplementDigitalText({
    precise: true, hasEnoughText: true, corruptTextLayer: false,
    targetAnchorSeen: true, parsed: partial,
  }), true);
  assert.equal(shouldSupplementDigitalText({
    precise: false, hasEnoughText: true, corruptTextLayer: false,
    targetAnchorSeen: true, parsed: partial,
  }), false);
  assert.equal(shouldSupplementDigitalText({
    precise: true, hasEnoughText: true, corruptTextLayer: false,
    targetAnchorSeen: false, parsed: parseRegisterLines(["기타주주 203,025,104주", "합계 203,025,104주"], target),
  }), false);
});

test("long scans recover the target page after scanning all pages instead of exhausting unrelated pages", () => {
  assert.deepEqual(selectPrecisionRecoveryPages([
    { pageNumber: 1, targetAnchorSeen: false, score: 100 },
    { pageNumber: 2, targetAnchorSeen: true, score: 20 },
    { pageNumber: 3, targetAnchorSeen: false, score: 80 },
    { pageNumber: 4, targetAnchorSeen: false, score: 70 },
  ]), [2]);
  assert.deepEqual(selectPrecisionRecoveryPages([
    { pageNumber: 1, targetAnchorSeen: true, score: 20 },
    { pageNumber: 2, targetAnchorSeen: false, score: 80 },
    { pageNumber: 3, targetAnchorSeen: false, score: 70 },
  ]), [1]);
});

test("orientation recovery is limited to unreadable scans rather than readable registers without the target", () => {
  assert.equal(selectOrientationRecoveryPage([
    { pageNumber: 1, targetAnchorSeen: false, score: 2, text: "ᄋ ᄋ 1300 [1] x" },
    { pageNumber: 2, targetAnchorSeen: false, score: 4, text: "XXXX 3510 ᄇ" },
  ]), 2);
  assert.equal(selectOrientationRecoveryPage([
    { pageNumber: 1, targetAnchorSeen: false, score: 4, text: "주 주 명 부\n기타주주 보 통 주 1,000주" },
  ]), null);
});

test("a matched target page takes priority over a loose anchor belonging to another fund number", () => {
  assert.deepEqual(selectPrecisionRecoveryPages([
    { pageNumber: 1, targetAnchorSeen: true, targetNameMatched: false, score: 20 },
    { pageNumber: 2, targetAnchorSeen: true, targetNameMatched: true, score: 15 },
    { pageNumber: 3, targetAnchorSeen: false, targetNameMatched: false, score: 5 },
  ]), [2]);
});
