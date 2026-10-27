"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Worker as TesseractWorker } from "tesseract.js";
import { cleanCompany, findTargetAnchorIndex, OCR_PAGE_BREAK, ocrTextScore, parseRegisterLines } from "@/lib/register-parser";
import { buildCanonicalTargetBlock, hasTargetHolding, selectCanonicalTargetEvidence, selectOrientationRecoveryPage, selectPrecisionRecoveryPages, shouldSupplementDigitalText } from "@/lib/ocr-evidence";
import { encodeCsv, upsertById } from "@/lib/result-utils";

type JobState = "ready" | "working" | "done" | "error";
type AnalysisPass = "basic" | "precise";

type PdfJob = {
  id: string;
  file: File;
  state: JobState;
  attempt: "none" | AnalysisPass;
  progress: number;
  note: string;
};

type Result = {
  id: string;
  fileName: string;
  issuer: string;
  total: number | null;
  holdings: Array<{ shareClass: string; shares: number }>;
  owned: number | null;
  ratio: number | null;
  matchedName: string;
  nameMatch: "정확" | "유사" | "실패";
  method: "PDF 텍스트" | "OCR" | "미완료";
  analysisPass: AnalysisPass;
  confidence: "높음" | "보통" | "확인 필요" | "실패";
  note: string;
};

type ExpandedResultRow = {
  result: Result;
  holding: Result["holdings"][number] | null;
  holdingIndex: number;
};

function expandResultRows(results: Result[]): ExpandedResultRow[] {
  return results.flatMap((result) => {
    const holdings: Array<Result["holdings"][number] | null> = result.holdings.length ? result.holdings : [null];
    return holdings.map((holding, holdingIndex) => ({ result, holding, holdingIndex }));
  });
}

const numberFormat = new Intl.NumberFormat("ko-KR");
const ANALYSIS_CONFIG: Record<AnalysisPass, { label: string; timeoutMs: number }> = {
  basic: { label: "기본 분석", timeoutMs: 30_000 },
  precise: { label: "정밀 재분석", timeoutMs: 90_000 },
};

class AnalysisTimeoutError extends Error {
  constructor(pass: AnalysisPass) {
    const config = ANALYSIS_CONFIG[pass];
    super(`${config.label} 시간 ${config.timeoutMs / 1_000}초 초과`);
    this.name = "AnalysisTimeoutError";
  }
}

function getAbortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("분석 작업이 취소되었습니다.");
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw getAbortError(signal);
}

function throwIfDeadlineExceeded(signal: AbortSignal, deadlineAt: number, timeoutError: AnalysisTimeoutError) {
  throwIfAborted(signal);
  if (Date.now() >= deadlineAt) throw timeoutError;
}

/**
 * Reject the caller as soon as its document deadline expires, while still
 * observing the underlying promise so a late worker failure never becomes an
 * unhandled rejection.
 */
function raceWithAbort<T>(task: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(getAbortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(getAbortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(task).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function yieldToMainThread() {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

function isCompleteOcrParse(parsed: ReturnType<typeof parseRegisterLines>) {
  return parsed.nameMatch !== "실패"
    && parsed.owned !== null
    && parsed.total !== null
    && parsed.holdings.length > 0;
}

function hasExplicitTotalAnchor(text: string) {
  return /(?:발\s*행\s*주\s*식\s*(?:총\s*수|수)|총\s*발\s*행\s*주\s*식\s*수|총\s*주\s*식\s*수|주\s*식\s*총\s*수|합\s*(?:계|[Aa][Il]?|ㅅ)|총\s*계)/i.test(text);
}

function findTargetIndex(lines: string[], target: string) {
  const compactTarget = cleanCompany(target);
  for (let index = 0; index < lines.length; index += 1) {
    for (let span = 1; span <= 4 && index + span <= lines.length; span += 1) {
      const candidate = cleanCompany(lines.slice(index, index + span).join(" "));
      if (candidate.includes(compactTarget)) return index;
    }
  }

  if (compactTarget.length >= 8) {
    const leadingAnchor = compactTarget.slice(0, 6);
    const trailingAnchor = compactTarget.slice(-6);
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = cleanCompany(lines.slice(index, index + 4).join(" "));
      if (candidate.includes(leadingAnchor) && candidate.includes(trailingAnchor)) return index;
    }
  }
  return -1;
}

const shareClassPattern = /(?:제\s*\d+\s*종\s*)?(?:(?:상\s*환\s*전\s*환|전\s*환\s*상\s*환|상\s*환|전\s*환)\s*)?(?:(?:우|무)\s*선|(?:우|으)\s*서)\s*주\s*(?:식)?|(?:상\s*환\s*전\s*환|전\s*환\s*상\s*환)\s*주\s*(?:식)?|보\s*통\s*주\s*(?:식)?|\bRCPS\b|\bCPS\b|\bCS\b/gi;

function normalizeShareClass(value: string) {
  const compact = value.replace(/\s|주식$/g, "").toUpperCase();
  const series = compact.match(/^제(\d+)종/)?.[1] ?? null;
  const repaired = compact.replace(/^제\d+종/, "").replace(/무선주/g, "우선주").replace(/(?:우|으)서주/g, "우선주");
  let normalized: string;
  if (repaired === "CS" || repaired.includes("보통주")) normalized = "보통주";
  else if (repaired === "RCPS") normalized = "상환전환우선주";
  else if (repaired === "CPS") normalized = "전환우선주";
  else if (repaired === "무선" || repaired === "우서" || repaired === "우선주") normalized = "우선주";
  else if (repaired.includes("상환") && repaired.includes("전환")) normalized = repaired.includes("우선") ? "상환전환우선주" : "상환전환주";
  else normalized = repaired.replace(/(우선)$/, "$1주");
  return series ? `제${series}종 ${normalized}` : normalized;
}

function toNumber(value: string | undefined) {
  if (!value) return null;
  const normalized = value.replace(/[Oo]/g, "0").replace(/[,\s]/g, "").replace(/[^0-9.]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function numbersIn(value: string) {
  return [...value.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)]
    .map((match) => ({ value: toNumber(match[0]), index: match.index ?? 0 }))
    .filter((item): item is { value: number; index: number } => item.value !== null);
}

function findKeywordNumber(lines: string[], keyword: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!keyword.test(lines[index])) continue;
    const window = lines.slice(index, index + 3).join(" ");
    const values = numbersIn(window).map((item) => item.value).filter((value) => value >= 0);
    if (values.length) return Math.max(...values);
  }
  return null;
}

function findClosestKeywordNumber(lines: string[], keyword: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyword);
    if (!match || match.index === undefined) continue;
    const afterKeyword = lines[index].slice(match.index + match[0].length);
    const sameLine = numbersIn(afterKeyword).find((item) => item.value >= 0)?.value;
    if (sameLine !== undefined) return sameLine;
    const nextLine = numbersIn(lines[index + 1] ?? "").find((item) => item.value >= 0)?.value;
    if (nextLine !== undefined) return nextLine;
  }
  return null;
}

function findIssuedClassNumber(lines: string[], keyword: RegExp, targetIndex: number) {
  for (let index = 0; index < lines.length; index += 1) {
    if (targetIndex >= 0 && Math.abs(index - targetIndex) <= 3) continue;
    const match = lines[index].match(keyword);
    if (!match || match.index === undefined) continue;
    const context = lines.slice(Math.max(0, index - 2), index + 3).join(" ");
    if (!/(?:발행|주식의\s*총수|발행주식수|자본금|주식수\s*합계)/.test(context)) continue;
    const afterKeyword = lines[index].slice(match.index + match[0].length);
    const sameLine = numbersIn(afterKeyword).find((item) => item.value >= 0)?.value;
    if (sameLine !== undefined) return sameLine;
    if (/(?:발행|총수|주식수)/.test(lines[index])) {
      const nextLine = numbersIn(lines[index + 1] ?? "").find((item) => item.value >= 0)?.value;
      if (nextLine !== undefined) return nextLine;
    }
  }
  return null;
}

// Retained as a conservative fallback reference while the line parser fixtures are expanded.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseRegisterLegacy(text: string, target: string, fileName: string, method: Result["method"]): Result {
  const lines = text
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const targetIndex = findTargetIndex(lines, target);

  const holdingsMap = new Map<string, number>();
  let owned: number | null = null;
  let extractedRatio: number | null = null;
  if (targetIndex >= 0) {
    const headerWindow = lines.slice(Math.max(0, targetIndex - 8), targetIndex).join(" ");
    const hasOrdinaryColumn = /보통주(?:식)?/.test(headerWindow);
    const hasPreferredColumn = /우선주(?:식)?/.test(headerWindow);
    const rowWindow = lines.slice(targetIndex, targetIndex + 6).join(" ");
    const classMatches = [...rowWindow.matchAll(shareClassPattern)];
    let classRatioSum = 0;

    for (let classIndex = 0; classIndex < classMatches.length; classIndex += 1) {
      const match = classMatches[classIndex];
      const start = match.index ?? 0;
      const end = classMatches[classIndex + 1]?.index ?? rowWindow.length;
      const segment = rowWindow.slice(start, end);
      const percentMatch = segment.match(/(\d+(?:\.\d+)?)\s*%/);
      const beforePercent = percentMatch ? segment.slice(0, percentMatch.index) : segment;
      const shareCandidates = numbersIn(beforePercent)
        .map((item) => item.value)
        .filter((value) => value >= 1 && value < 1_000_000_000_000);
      const shares = shareCandidates[shareCandidates.length - 1] ?? null;
      if (shares !== null) {
        const shareClass = normalizeShareClass(match[0]);
        holdingsMap.set(shareClass, (holdingsMap.get(shareClass) ?? 0) + shares);
      }
      const classRatio = toNumber(percentMatch?.[1]);
      if (classRatio !== null) classRatioSum += classRatio;
    }

    if (holdingsMap.size) {
      owned = [...holdingsMap.values()].reduce((sum, shares) => sum + shares, 0);
      extractedRatio = classRatioSum || null;
    } else {
      const percentMatch = rowWindow.match(/(\d+(?:\.\d+)?)\s*%/);
      extractedRatio = toNumber(percentMatch?.[1]);
      const beforePercent = percentMatch ? rowWindow.slice(0, percentMatch.index) : rowWindow;
      const candidates = numbersIn(beforePercent)
        .map((item) => item.value)
        .filter((value) => value >= 1 && value < 1_000_000_000_000);
      if (hasOrdinaryColumn && hasPreferredColumn && candidates.length >= 3) {
      const [ordinaryCandidate, preferredCandidate, totalCandidate] = candidates.slice(-3);
      if (Math.abs(ordinaryCandidate + preferredCandidate - totalCandidate) <= 1) {
        holdingsMap.set("보통주", ordinaryCandidate);
        holdingsMap.set("우선주", preferredCandidate);
        owned = totalCandidate;
      } else {
        const ordinary = candidates[candidates.length - 2];
        const preferred = candidates[candidates.length - 1];
        holdingsMap.set("보통주", ordinary);
        holdingsMap.set("우선주", preferred);
        owned = ordinary + preferred;
      }
      } else if (hasOrdinaryColumn && hasPreferredColumn && candidates.length >= 2) {
        const [first, second] = candidates.slice(-2);
        if (first <= 1000 && second > first * 10) {
          owned = second;
        } else {
          holdingsMap.set("보통주", first);
          holdingsMap.set("우선주", second);
          owned = first + second;
        }
      } else if (candidates.length) {
        owned = candidates[candidates.length - 1];
        if (hasPreferredColumn && !hasOrdinaryColumn) holdingsMap.set("우선주", owned);
        else if (hasOrdinaryColumn) holdingsMap.set("보통주", owned);
      }
    }
  }

  let issuedOrdinary = findIssuedClassNumber(lines, /보통주(?:식)?/, targetIndex);
  let issuedPreferred = findIssuedClassNumber(lines, /우선주(?:식)?/, targetIndex);
  let total: number | null = findKeywordNumber(lines, /발행주식.*(?:총수|합계)|총\s*발행주식|주식의\s*총수/);
  if (total === null) {
    issuedOrdinary ??= findClosestKeywordNumber(lines, /보통주(?:식)?/);
    issuedPreferred ??= findClosestKeywordNumber(lines, /우선주(?:식)?/);
    total = issuedOrdinary !== null ? issuedOrdinary + (issuedPreferred ?? 0) : null;
  }
  if (total !== null && issuedOrdinary !== null && issuedPreferred === null) {
    issuedPreferred = Math.max(0, total - issuedOrdinary);
  }
  if (total !== null && issuedPreferred !== null && issuedOrdinary === null) {
    issuedOrdinary = Math.max(0, total - issuedPreferred);
  }
  const calculatedRatio = total && owned !== null ? (owned / total) * 100 : null;
  const ratio = calculatedRatio;
  const mismatched = calculatedRatio !== null && extractedRatio !== null && Math.abs(calculatedRatio - extractedRatio) > 0.05;
  const holdings = [...holdingsMap].map(([shareClass, shares]) => ({ shareClass, shares }));
  const holdingsTotal = holdings.reduce((sum, item) => sum + item.shares, 0);
  const ownedTotalMismatch = owned !== null && holdings.length > 0 && Math.abs(holdingsTotal - owned) > 1;
  const missing = [total, owned, ratio].filter((value) => value === null).length;
  const missingClassBreakdown = owned !== null && holdings.length === 0;
  const confidence: Result["confidence"] = mismatched || ownedTotalMismatch || missing > 0 || missingClassBreakdown
    ? "확인 필요"
    : missing === 1 || method === "OCR" ? "보통" : "높음";
  const note = targetIndex < 0
    ? "대상 회사명을 찾지 못했습니다. 표기 차이를 확인해 주세요."
    : mismatched || ownedTotalMismatch
      ? "종류별 합계 또는 지분율이 맞지 않아 원문 확인이 필요합니다."
      : missingClassBreakdown
        ? "보유주식수의 종류별 구분을 찾지 못했습니다. 원문을 확인해 주세요."
      : missing
        ? "일부 값을 찾지 못했습니다. 원문을 확인해 주세요."
        : method === "OCR"
          ? "스캔 문서를 OCR로 읽었습니다. 숫자를 한 번 확인해 주세요."
          : "추출값과 계산값이 일치합니다.";

  return {
    id: crypto.randomUUID(),
    fileName,
    issuer: fileName.replace(/\.pdf$/i, ""),
    total,
    holdings,
    owned,
    ratio,
    matchedName: "",
    nameMatch: targetIndex < 0 ? "실패" : "정확",
    method,
    analysisPass: "basic",
    confidence,
    note,
  };
}

function parseRegister(
  text: string,
  target: string,
  fileName: string,
  method: Result["method"],
  resultId: string,
  analysisPass: AnalysisPass,
): Result {
  const parsed = parseRegisterLines(text.split(/\r?\n/), target);
  return {
    id: resultId,
    fileName,
    issuer: fileName.replace(/\.pdf$/i, ""),
    method,
    analysisPass,
    ...parsed,
  };
}

function failedResult(resultId: string, fileName: string, analysisPass: AnalysisPass, note: string): Result {
  return {
    id: resultId,
    fileName,
    issuer: fileName.replace(/\.pdf$/i, ""),
    total: null,
    holdings: [],
    owned: null,
    ratio: null,
    matchedName: "",
    nameMatch: "실패",
    method: "미완료",
    analysisPass,
    confidence: "실패",
    note,
  };
}

function finalizePassResult(result: Result): Result {
  const complete = result.nameMatch !== "실패"
    && result.owned !== null
    && result.total !== null
    && result.holdings.length > 0;
  const passLabel = result.analysisPass === "basic" ? "1차 기본 분석" : "2차 정밀 재분석";
  if (!complete) {
    const detail = result.note ? ` · ${result.note}` : "";
    return {
      ...result,
      confidence: "실패",
      note: `${passLabel}에서 필요한 값을 모두 찾지 못했습니다${detail}`,
    };
  }
  if (result.analysisPass === "precise") {
    return { ...result, note: `정밀 재분석 완료${result.note ? ` · ${result.note}` : ""}` };
  }
  return result;
}

async function extractPdf(
  file: File,
  target: string,
  onProgress: (value: number, note: string) => void,
  getOcrWorker: (logger: (progress: number) => void, signal: AbortSignal) => Promise<TesseractWorker>,
  analysisPass: AnalysisPass,
  signal: AbortSignal,
  deadlineAt: number,
  timeoutError: AnalysisTimeoutError,
) {
  const parseCache = new Map<string, ReturnType<typeof parseRegisterLines>>();
  const anchorCache = new Map<string, number>();
  const scoreCache = new Map<string, number>();
  const parseCandidate = (lines: string[], candidateTarget: string) => {
    const normalized = lines.map((line) => line.replace(/\u00a0/g, " ").replace(/[ ]+/g, " ").trim()).filter(Boolean);
    const key = `${candidateTarget}\0${normalized.join("\n")}`;
    let parsed = parseCache.get(key);
    if (parsed === undefined) {
      parsed = parseRegisterLines(normalized, candidateTarget);
      parseCache.set(key, parsed);
    }
    return parsed;
  };
  const findCandidateAnchor = (lines: string[], candidateTarget: string) => {
    const key = `${candidateTarget}\0${lines.join("\n")}`;
    let anchor = anchorCache.get(key);
    if (anchor === undefined) {
      anchor = findTargetAnchorIndex(lines, candidateTarget);
      anchorCache.set(key, anchor);
    }
    return anchor;
  };
  const scoreCandidateText = (text: string, candidateTarget: string) => {
    const key = `${candidateTarget}\0${text}`;
    let score = scoreCache.get(key);
    if (score === undefined) {
      score = ocrTextScore(text, candidateTarget);
      scoreCache.set(key, score);
    }
    return score;
  };
  throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
  const [pdfjs, pdfWorkerModule] = await raceWithAbort(Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]), signal);
  const pdfWorkerUrl = pdfWorkerModule.default;
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const bytes = new Uint8Array(await raceWithAbort(file.arrayBuffer(), signal));
  const loadingTask = pdfjs.getDocument({ data: bytes });
  let pdf: Awaited<typeof loadingTask.promise>;
  const trackedCanvases = new Set<HTMLCanvasElement>();
  const makeCanvas = () => {
    const canvas = document.createElement("canvas");
    trackedCanvases.add(canvas);
    return canvas;
  };
  const releaseCanvas = (canvas: HTMLCanvasElement) => {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
    trackedCanvases.delete(canvas);
  };

  try {
    pdf = await raceWithAbort(loadingTask.promise, signal);
  } catch (error) {
    if (signal.aborted) {
      try { await loadingTask.destroy(); } catch { /* The loading task may already be gone. */ }
    }
    throw error;
  }

  try {
    const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
    const page = await raceWithAbort(pdf.getPage(pageNumber), signal);
    const content = await raceWithAbort(page.getTextContent(), signal);
    const positioned = content.items
      .filter((item) => "str" in item && item.str.trim() && "transform" in item)
      .map((item) => ({ text: "str" in item ? item.str.trim() : "", x: item.transform[4], y: item.transform[5] }))
      .sort((left, right) => Math.abs(right.y - left.y) > 3 ? right.y - left.y : left.x - right.x);
    const rows: Array<{ y: number; cells: Array<{ text: string; x: number }> }> = [];
    for (const item of positioned) {
      let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
      if (!row) { row = { y: item.y, cells: [] }; rows.push(row); }
      row.cells.push(item);
    }
    const pageText = rows.sort((left, right) => right.y - left.y)
      .map((row) => row.cells.sort((left, right) => left.x - right.x).map((cell) => cell.text).join("\t"))
      .join("\n");
    pageTexts.push(pageText);
    onProgress(Math.round((pageNumber / pdf.numPages) * 35), `텍스트 확인 중 · ${pageNumber}/${pdf.numPages}쪽`);
  }

  // Some PDF generators embed the same register page multiple times. Parsing
  // all copies triples totals such as 23,579 -> 70,737.
  const digitalText = [...new Map(pageTexts.map((text) => [text.replace(/\s/g, ""), text])).values()].join("\n");
  const compactDigitalText = digitalText.replace(/\s/g, "");
  const hasEnoughDigitalText = compactDigitalText.length >= Math.max(80, pdf.numPages * 25);
  const privateUseCount = digitalText.match(/[\uE000-\uF8FF]/gu)?.length ?? 0;
  const privateUseRatio = privateUseCount / Math.max(1, compactDigitalText.length);
  const hasCorruptPrivateUseLayer = privateUseCount >= 16 && privateUseRatio >= 0.1;
  const digitalParsed = parseCandidate(digitalText.split(/\r?\n/), target);
  const digitalTargetPages = pageTexts.flatMap((text, index) =>
    findCandidateAnchor(text.split(/\r?\n/).filter(Boolean), target) >= 0 ? [index + 1] : []);
  if (!shouldSupplementDigitalText({
    precise: analysisPass === "precise",
    hasEnoughText: hasEnoughDigitalText,
    corruptTextLayer: hasCorruptPrivateUseLayer,
    targetAnchorSeen: digitalTargetPages.length > 0,
    parsed: digitalParsed,
  })) {
    return { text: digitalText, method: "PDF 텍스트" as const };
  }

  const worker = await getOcrWorker((progress) => onProgress(40 + Math.round(progress * 55), "한글 OCR 분석 중"), signal);
  const ocrText: string[] = [];
  let canonicalTargetEvidence = hasEnoughDigitalText ? selectCanonicalTargetEvidence([digitalParsed]) : null;
  const allPageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
  const ocrPageNumbers = hasEnoughDigitalText && !hasCorruptPrivateUseLayer && digitalTargetPages.length
    ? [...new Set([...digitalTargetPages, ...(digitalParsed.total === null ? [pdf.numPages] : [])])]
    : allPageNumbers;
  const multiPagePrecision = analysisPass === "precise" && pdf.numPages > 3;
  const renderOcrPage = async (pageNumber: number, scale: number) => {
    throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
    const page = await raceWithAbort(pdf.getPage(pageNumber), signal);
    const viewport = page.getViewport({ scale });
    const canvas = makeCanvas();
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("페이지 이미지를 만들 수 없습니다.");
    const renderTask = page.render({ canvas, canvasContext: context, viewport });
    const cancelRender = () => renderTask.cancel();
    signal.addEventListener("abort", cancelRender, { once: true });
    try {
      await raceWithAbort(renderTask.promise, signal);
    } finally {
      signal.removeEventListener("abort", cancelRender);
    }
    return { canvas, context };
  };
  const sparsePages = new Map<number, { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; text: string }>();
  const orientationCandidates = new Map<number, Array<{ text: string; score: number; degrees: number; mode: string }>>();
  let recoveryPages = new Set<number>();
  if (multiPagePrecision) {
    const pageEvidence: Array<{ pageNumber: number; targetAnchorSeen: boolean; targetNameMatched: boolean; score: number; text: string }> = [];
    for (const pageNumber of ocrPageNumbers) {
      const rendered = await renderOcrPage(pageNumber, 2);
      await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "11" }), signal);
      const reading = await raceWithAbort(worker.recognize(rendered.canvas), signal);
      const text = reading.data.text;
      const parsed = parseCandidate(text.split(/\r?\n/), target);
      sparsePages.set(pageNumber, { ...rendered, text });
      pageEvidence.push({
        pageNumber,
        targetAnchorSeen: findCandidateAnchor(text.split(/\r?\n/).filter(Boolean), target) >= 0,
        targetNameMatched: parsed.nameMatch !== "실패",
        score: scoreCandidateText(text, target),
        text,
      });
      onProgress(40 + Math.round((sparsePages.size / ocrPageNumbers.length) * 30), `전체 페이지 빠른 OCR · ${sparsePages.size}/${ocrPageNumbers.length}쪽`);
    }
    recoveryPages = new Set(selectPrecisionRecoveryPages(pageEvidence));
    const orientationPage = selectOrientationRecoveryPage(pageEvidence);
    const orientationSource = orientationPage === null ? null : sparsePages.get(orientationPage);
    if (orientationPage !== null && orientationSource) {
      const readings: Array<{ text: string; score: number; degrees: number; mode: string }> = [];
      for (const degrees of [90, 270]) {
        if (deadlineAt - Date.now() <= 15_000) break;
        const reading = await raceWithAbort(worker.recognize(orientationSource.canvas, { rotateRadians: degrees * Math.PI / 180 }), signal);
        readings.push({ text: reading.data.text, score: scoreCandidateText(reading.data.text, target), degrees, mode: "raw-11" });
        if (hasTargetHolding(parseCandidate(reading.data.text.split(/\r?\n/), target))) break;
      }
      orientationCandidates.set(orientationPage, readings);
    }
  }
  for (const pageNumber of ocrPageNumbers) {
    throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
    const page = await raceWithAbort(pdf.getPage(pageNumber), signal);
    const cachedPage = sparsePages.get(pageNumber);
    let { canvas, context } = cachedPage ?? await renderOcrPage(pageNumber,
      analysisPass === "precise" ? (pdf.numPages > 2 ? 2 : 3) : 2.2);
    const candidates: Array<{ text: string; score: number; degrees?: number; mode?: string }> = cachedPage
      ? [{ text: cachedPage.text, score: scoreCandidateText(cachedPage.text, target), mode: "raw-11" }, ...(orientationCandidates.get(pageNumber) ?? [])]
      : [];
    let rawDocumentComplete = false;
    let rawPageSufficient = multiPagePrecision;

    // 정밀 분석은 표 선을 지우기 전의 원본을 먼저 읽는다. 선 제거는 숫자
    // 칸에는 유리하지만 여러 줄 회사명과 합계 라벨을 훼손할 수 있다.
    if (analysisPass === "precise") {
      // Sparse text is the most reliable first pass for ruled shareholder
      // tables. Automatic layout remains the fallback for documents whose
      // totals are preserved better as full rows.
      // Longer scans already have one sparse reading of every page. Give only
      // target-bearing pages one alternate layout pass and reserve ten seconds
      // for candidate selection and totals, instead of exhausting the deadline
      // on repeated rotations. Two-page tables keep their established modes.
      const rawModes = multiPagePrecision
        ? (recoveryPages.has(pageNumber) && deadlineAt - Date.now() > 10_000 ? ["3"] : [])
        : pdf.numPages > 2 ? (pageNumber > 1 && hasTargetHolding(canonicalTargetEvidence) ? ["11"] : ["3"])
        : pdf.numPages === 1 ? ["3", "11", "6"] : ["3", "11"];
      for (const mode of rawModes) {
        await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: mode }), signal);
        const rawReading = await raceWithAbort(worker.recognize(canvas), signal);
        candidates.push({ text: rawReading.data.text, score: scoreCandidateText(rawReading.data.text, target), mode: `raw-${mode}` });
        if (typeof document !== "undefined" && new URLSearchParams(document.location.search).has("debug")) {
          const payload = { pageNumber, mode: `raw-${mode}`, text: rawReading.data.text };
          document.documentElement.setAttribute("data-last-ocr", encodeURIComponent(JSON.stringify(payload)));
        }
        const rawDocumentText = [...ocrText, ...candidates.map((candidate) => candidate.text)].join("\n");
        const rawParsed = parseCandidate(rawDocumentText.split(/\r?\n/), target);
        const targetReliable = rawParsed.nameMatch !== "실패" && rawParsed.owned !== null;
        const totalReliable = rawParsed.total !== null && hasExplicitTotalAnchor(rawDocumentText);
        rawDocumentComplete = isCompleteOcrParse(rawParsed) && totalReliable
          && rawParsed.confidence !== "확인 필요";
        // A total without the target holding is not sufficient when the target
        // anchor is present on this page (블루닷). Continue into processed OCR.
        rawPageSufficient = multiPagePrecision || pageNumber < pdf.numPages && targetReliable;
        // On the first page of a multi-page scan, PSM 3 can find the target row
        // while dropping a narrow share-class cell or the exact issued-share
        // quantity. Always give sparse PSM 11 one chance before accepting that
        // first-page result. This prevents ratio-derived near misses such as
        // 119,884 instead of the printed 119,875, and recovers classes that are
        // absent from PSM 3 (for example 셀인셀즈).
        const highConfidenceComplete = rawDocumentComplete && rawParsed.confidence === "높음";
        // A previous page is not evidence that PSM 3 captured every class on
        // the current page.  When PSM 11 is scheduled, always let it run once
        // before accepting a complete-looking PSM 3 result (램쉽 page 2).
        const mayStopAfterThisRawMode = mode === "11" || rawModes.length === 1;
        if (rawPageSufficient && mode === "11" || highConfidenceComplete && mayStopAfterThisRawMode) break;
      }
      const rawTargetAnchorSeen = candidates.some((candidate) =>
        findCandidateAnchor(candidate.text.split(/\r?\n/).filter(Boolean), target) >= 0);
      // Once a three-or-more-page register has already produced trustworthy
      // target evidence, later non-target pages are needed only for subtotals
      // and the grand total. One layout-preserving raw pass is sufficient;
      // running processed/rotated fallbacks on the final page exceeds the
      // 90-second document budget without improving the target holding.
      const laterTotalsOnlyPage = pdf.numPages > 2 && pageNumber > 1
        && hasTargetHolding(canonicalTargetEvidence) && !rawTargetAnchorSeen;
      if (!rawTargetAnchorSeen && (pageNumber < pdf.numPages || laterTotalsOnlyPage)) rawPageSufficient = true;
      await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "6" }), signal);
    }

    if (multiPagePrecision && recoveryPages.has(pageNumber)) {
      // Sparse/automatic OCR can keep the name and quantity while losing a
      // narrow stock-class cell. Give only that target page one ruled-table
      // reading, rather than accepting an incomplete sparse result.
      rawPageSufficient = candidates.some((candidate) => {
        const parsed = parseCandidate(candidate.text.split(/\r?\n/), target);
        return hasTargetHolding(parsed) && parsed.holdings.length > 0
          && parsed.holdings.every((holding) => holding.shareClass !== "주식종류 미표시");
      });
    }
    if (!rawDocumentComplete && !rawPageSufficient) {
      if (multiPagePrecision) {
        // Keep the full-document sweep small, but restore the established
        // basic-pass resolution before rule removal on a difficult target row.
        // At 144 DPI narrow 4/6 glyphs can merge with the erased table rules.
        const detailed = await renderOcrPage(pageNumber, 2.2);
        releaseCanvas(canvas);
        canvas = detailed.canvas;
        context = detailed.context;
      }
      // Long table rules cause Tesseract to discard entire cells. Remove only
      // continuous horizontal/vertical strokes, preserving the shorter glyphs.
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const { width, height, data } = pixels;
      const dark = (x: number, y: number) => data[(y * width + x) * 4] < 150;
      const mask = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        if (y > 0 && y % 512 === 0) {
          await yieldToMainThread();
          throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
        }
        let start = -1;
        for (let x = 0; x <= width; x++) {
          if (x < width && dark(x, y)) { if (start < 0) start = x; }
          else if (start >= 0) {
            if (x - start > width * 0.12) for (let k = start; k < x; k++) mask[y * width + k] = 1;
            start = -1;
          }
        }
      }
      for (let x = 0; x < width; x++) {
        if (x > 0 && x % 512 === 0) {
          await yieldToMainThread();
          throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
        }
        let start = -1;
        for (let y = 0; y <= height; y++) {
          if (y < height && dark(x, y)) { if (start < 0) start = y; }
          else if (start >= 0) {
            if (y - start > height * 0.08) for (let k = start; k < y; k++) mask[k * width + x] = 1;
            start = -1;
          }
        }
      }
      for (let i = 0; i < mask.length; i++) {
        if (i > 0 && i % 1_000_000 === 0) {
          await yieldToMainThread();
          throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
        }
        if (mask[i]) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
      }
      context.putImageData(pixels, 0, 0);
      await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "6" }), signal);
      const first = await raceWithAbort(worker.recognize(canvas), signal);
      candidates.push({ text: first.data.text, score: scoreCandidateText(first.data.text, target) });
      const fastDocumentText = [...ocrText, ...candidates.map((candidate) => candidate.text)].join("\n");
      const fastParsed = parseCandidate(fastDocumentText.split(/\r?\n/), target);
      const fastTarget = cleanCompany(target);
      const fastAnchoredFundRow = fastTarget.includes("abb")
        && /(?:ABB(?:E)?|(?:4|A)?\s*8\s*[86])[^\n]{0,120}?벤처투자조합[^\n]{0,120}?\d{3,}\s+(?:\d{1,2}\.\d+|\d{3})\s*%/i.test(fastDocumentText);
      const fastTargetReliable = fastParsed.owned !== null
        && (fastParsed.nameMatch === "정확" || fastAnchoredFundRow);
      const fastComplete = fastTargetReliable
        && (fastParsed.total !== null || pageNumber < pdf.numPages);
      // 기본 분석은 PSM 6 한 번만 사용해 빠르게 끝낸다. 정밀 재분석에서만
      // 희소/자동 레이아웃 OCR과 회전·원본 보강 단계를 수행한다.
      if (!fastComplete && analysisPass === "precise" && !multiPagePrecision) {
        await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "11" }), signal);
        const sparse = await raceWithAbort(worker.recognize(canvas), signal);
        candidates.push({ text: sparse.data.text, score: scoreCandidateText(sparse.data.text, target) });
        await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "3" }), signal);
        const automatic = await raceWithAbort(worker.recognize(canvas), signal);
        candidates.push({ text: automatic.data.text, score: scoreCandidateText(automatic.data.text, target) });
        await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "6" }), signal);
      }
    }
    const baseTexts = [
      ...candidates.map((candidate) => candidate.text),
      candidates.map((candidate) => candidate.text).join("\n"),
      [...ocrText, ...candidates.map((candidate) => candidate.text)].join("\n"),
    ];
    const baseComplete = baseTexts.some((text) => {
      const parsed = parseCandidate(text.split(/\r?\n/), target);
      return isCompleteOcrParse(parsed) && parsed.confidence !== "확인 필요";
    });
    const targetAnchorSeen = candidates.some((candidate) => findCandidateAnchor(candidate.text.split(/\r?\n/).filter(Boolean), target) >= 0);
    // On a multi-page register, do not spend four rotated/raw OCR passes on an
    // earlier page that plainly does not contain the requested shareholder.
    // Keep its normal/sparse text for totals and reserve exhaustive OCR for the
    // page where the target anchor appears (or the final page as a safeguard).
    const exhaustiveNeeded = analysisPass === "precise" && !multiPagePrecision && !rawPageSufficient
      && (targetAnchorSeen || pageNumber === pdf.numPages);
    if (!baseComplete && exhaustiveNeeded) {
      for (const degrees of [90, 270]) {
        const rotated = makeCanvas();
        rotated.width = canvas.height;
        rotated.height = canvas.width;
        const rotatedContext = rotated.getContext("2d");
        if (!rotatedContext) continue;
        rotatedContext.translate(rotated.width / 2, rotated.height / 2);
        rotatedContext.rotate(degrees * Math.PI / 180);
        rotatedContext.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
        const rotatedResult = await raceWithAbort(worker.recognize(rotated), signal);
        candidates.push({ text: rotatedResult.data.text, score: scoreCandidateText(rotatedResult.data.text, target), degrees });
        await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "11" }), signal);
        const rotatedSparse = await raceWithAbort(worker.recognize(rotated), signal);
        candidates.push({ text: rotatedSparse.data.text, score: scoreCandidateText(rotatedSparse.data.text, target), degrees });
        await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "6" }), signal);
        releaseCanvas(rotated);
      }
    }
    // Rule removal can improve totals while damaging a multi-line shareholder
    // name or a narrow stock-class cell. Retain one raw sparse reading when the
    // holding was found but every candidate lost its class; run the full raw
    // fallback only when the holding itself is still missing.
    const candidateParses = candidates.map((candidate) => parseCandidate(candidate.text.split(/\r?\n/), target));
    const hasOwnedCandidate = candidateParses.some((parsed) => parsed.owned !== null);
    const hasClassedOwnedCandidate = candidateParses.some((parsed) => parsed.owned !== null
      && parsed.holdings.some((holding) => holding.shareClass !== "주식종류 미표시"));
    const classOnlyRecovery = hasOwnedCandidate && !hasClassedOwnedCandidate;
    let rawClassEvidence = "";
    if (exhaustiveNeeded && (!hasOwnedCandidate || classOnlyRecovery)) {
      const direction = [...candidates].sort((a, b) => b.score - a.score)[0].degrees ?? 0;
      const raw = makeCanvas();
      const rawViewport = page.getViewport({ scale: 3 });
      raw.width = Math.ceil(rawViewport.width);
      raw.height = Math.ceil(rawViewport.height);
      const rawContext = raw.getContext("2d")!;
      const rawRenderTask = page.render({ canvas: raw, canvasContext: rawContext, viewport: rawViewport });
      const cancelRawRender = () => rawRenderTask.cancel();
      signal.addEventListener("abort", cancelRawRender, { once: true });
      try {
        await raceWithAbort(rawRenderTask.promise, signal);
      } finally {
        signal.removeEventListener("abort", cancelRawRender);
      }
      const oriented = makeCanvas();
      oriented.width = direction ? raw.height : raw.width;
      oriented.height = direction ? raw.width : raw.height;
      const orientedContext = oriented.getContext("2d")!;
      orientedContext.translate(oriented.width / 2, oriented.height / 2);
      orientedContext.rotate(direction * Math.PI / 180);
      orientedContext.drawImage(raw, -raw.width / 2, -raw.height / 2);
      for (const mode of classOnlyRecovery ? ["11"] : ["6", "11", "4", "3"]) {
        await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: mode }), signal);
        const reading = await raceWithAbort(worker.recognize(oriented), signal);
        candidates.push({ text: reading.data.text, score: scoreCandidateText(reading.data.text, target), degrees: direction });
        if (classOnlyRecovery && mode === "11") {
          const rawLines = reading.data.text.split(/\r?\n/).filter(Boolean);
          const anchor = findCandidateAnchor(rawLines, target);
          const targetBlock = anchor >= 0 ? rawLines.slice(anchor, anchor + 6).join("\n") : "";
          const classes = new Set([...targetBlock.matchAll(shareClassPattern)].map((item) => normalizeShareClass(item[0])));
          if (classes.size === 1) rawClassEvidence = [...classes][0];
        }
      }
      await raceWithAbort(worker.setParameters({ tessedit_pageseg_mode: "6" }), signal);
      releaseCanvas(raw);
      releaseCanvas(oriented);
    }
    const selectionCandidateParses = candidates.map((candidate) => parseCandidate(candidate.text.split(/\r?\n/), target));
    canonicalTargetEvidence = selectCanonicalTargetEvidence([
      canonicalTargetEvidence,
      selectCanonicalTargetEvidence(selectionCandidateParses),
    ]);
    // Keep an explicitly anchored, non-rounded total even when unrelated damage
    // in the same OCR candidate makes its target-row confidence low. This lets a
    // clean holdings-only mode use the exact footer total (넥스젠파워 35,295).
    const exactLookingTotals = candidates.map((candidate, index) => ({ candidate, parsed: selectionCandidateParses[index] }))
      .filter(({ candidate }) => hasExplicitTotalAnchor(candidate.text))
      .map(({ parsed }) => parsed.total)
      .filter((value): value is number => value !== null && (value < 10_000 ? value % 10 !== 0 : value % 100 !== 0));
    const exactTotalHint = [...exactLookingTotals].sort((left, right) =>
      exactLookingTotals.filter((value) => value === right).length - exactLookingTotals.filter((value) => value === left).length)[0] ?? null;
    const options: Array<{ text: string; score: number; mode?: string }> = candidates
      .map((candidate, index) => ({
        text: exactTotalHint !== null && selectionCandidateParses[index].owned !== null
          ? `총발행주식수 ${exactTotalHint}주\n${candidate.text}`
          : candidate.text,
        score: candidate.score,
        mode: candidate.mode,
      }));
    const distinctCandidateClasses = new Set(selectionCandidateParses.flatMap((parsed) => parsed.holdings
      .map((holding) => holding.shareClass).filter((shareClass) => shareClass !== "주식종류 미표시")));
    const maximumSingleClassCount = Math.max(0, ...selectionCandidateParses.map((parsed) => parsed.holdings.length));
    const complementaryClassEvidence = distinctCandidateClasses.size >= 2
      && distinctCandidateClasses.size > maximumSingleClassCount;
    const hasUsableCompleteSingle = !complementaryClassEvidence && options.some((candidate) => {
      const parsed = parseCandidate(candidate.text.split(/\r?\n/), target);
      return isCompleteOcrParse(parsed) && parsed.confidence !== "확인 필요";
    });
    // Combining two complete readings duplicates shareholder rows and can make
    // a currency amount look like a holding. Pair candidates only when no
    // trustworthy single OCR result contains both requested values.
    if (!hasUsableCompleteSingle) for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        if ((candidates[left].degrees ?? 0) !== (candidates[right].degrees ?? 0)) continue;
        const combinedText = `${options[left].text}\n${options[right].text}`;
        const combinedParsed = parseCandidate(combinedText.split(/\r?\n/), target);
        if (combinedParsed.confidence === "확인 필요") continue;
        options.push({ text: combinedText, score: (candidates[left].score + candidates[right].score) / 2, mode: "combined" });
      }
    }
    const bestCandidate = options.map((candidate) => {
      const extracted = parseCandidate(candidate.text.split(/\r?\n/), target);
      // Prefer a single OCR result or complementary pair that yields both holdings and total shares.
      const hasTarget = extracted.nameMatch !== "실패";
      const exactName = extracted.nameMatch === "정확";
      const knownClasses = extracted.holdings.length > 0
        && extracted.holdings.every((holding) => holding.shareClass !== "주식종류 미표시");
      // Automatic layout is strongest for a dense one-page table. Sparse layout
      // is safer for multi-page scans because it preserves separated footer
      // totals and narrow stock-class cells.
      const preferredRawModeBonus = candidate.mode === (pdf.numPages > 1 ? "raw-11" : "raw-3") ? 2 : 0;
      const extractionScore = (extracted.owned !== null ? 16 : 0)
        + (extracted.total !== null ? hasTarget ? 12 : 8 : 0)
        + (extracted.ratio !== null ? 4 : 0)
        + (exactName ? 9 : hasTarget ? 3 : 0)
        + (knownClasses ? 5 : -4)
        + Math.min(4, extracted.holdings.length) * 6
        + (extracted.confidence === "높음" ? 7 : extracted.confidence === "확인 필요" ? -6 : 0)
        + preferredRawModeBonus;
      return { ...candidate, quality: candidate.score + extractionScore };
    }).sort((left, right) => right.quality - left.quality || right.score - left.score)[0];
    const bestCandidateParsed = parseCandidate(bestCandidate.text.split(/\r?\n/), target);
    const fusedClassHoldingLine = rawClassEvidence && bestCandidateParsed.owned !== null
      && bestCandidateParsed.holdings.every((holding) => holding.shareClass === "주식종류 미표시")
      ? `${target} ${rawClassEvidence} ${bestCandidateParsed.owned}주`
      : "";
    const totalLabel = /(?:합\s*(?:계|[Aa][Il]?|ㅅ)|총\s*계|총\s*발행\s*주식수|주식\s*총수)/;
    const supplementalTotalLines = hasUsableCompleteSingle ? [] : [...new Set(candidates.flatMap((candidate) => {
      const candidateParsed = parseCandidate(candidate.text.split(/\r?\n/), target);
      // A target row that contradicts its own printed percentage is not safe
      // evidence for class-subtotal inference. Explicit 합계/100% rows remain
      // eligible because they are independent of that damaged target row.
      const unsafeTargetCandidate = candidateParsed.nameMatch !== "실패"
        && candidateParsed.confidence === "확인 필요";
      const lines = candidate.text.split(/\r?\n/).filter(Boolean);
      const retained: string[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!/\d/.test(line)) continue;
        const totalAnchor = totalLabel.test(line) || /100(?:\.0+)?\s*%/.test(line)
          || line.length <= 80 && /(?:^|[\s|])10000\s*\|?\s*$/.test(line);
        if (totalAnchor) {
          retained.push(line);
          // OCR can emit each cell of one total row on its own line. Preserve a
          // compact context row so a quantity separated from 합계/100% survives
          // candidate selection without retaining the full duplicate page.
          const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
            .filter((item) => /\d/.test(item)).join(" ");
          if (context) retained.push(context);
          continue;
        }
        if (unsafeTargetCandidate) continue;
        // Keep possible class-subtotal rows even when OCR destroyed the label.
        // The final parser validates a neighboring pair by both 100% and the
        // quantities' own ratio before it is allowed to replace the total.
        const percent = Number(line.match(/(\d+(?:\.\d+)?)\s*%/)?.[1] ?? NaN);
        if (percent >= 5 && percent < 100) retained.push(line);
      }
      return retained;
    }))];
    const bestTotal = bestCandidateParsed.total;
    const inferredLookingBest = bestTotal !== null && (bestTotal < 10_000 ? bestTotal % 10 === 0 : bestTotal % 100 === 0);
    const exactTotal = inferredLookingBest ? exactLookingTotals.sort((left, right) =>
      exactLookingTotals.filter((value) => value === right).length - exactLookingTotals.filter((value) => value === left).length)[0] : null;
    const compactTarget = cleanCompany(target);
    // A merged shareholder-name cell can cover several stock rows. Different OCR
    // segmentation modes often read a different one of those rows, so preserve
    // the candidate block that contains the largest number of distinct classes.
    // This is especially important when the name itself is split over 2-3 lines.
    const hasMultiClassSingle = candidates.some((candidate) => {
      const parsed = parseCandidate(candidate.text.split(/\r?\n/), target);
      return parsed.holdings.length >= 2;
    });
    const supplementalTargetBlock = !hasMultiClassSingle
      || bestCandidateParsed.holdings.length >= maximumSingleClassCount ? "" : candidates.map((candidate) => {
      const lines = candidate.text.split(/\r?\n/).filter(Boolean);
      const start = findCandidateAnchor(lines, target);
      if (start < 0) return null;
      const block = lines.slice(Math.max(0, start - 2), start + 8).join("\n");
      const classNames = [...block.matchAll(/(?:상\s*환\s*)?(?:전\s*환\s*)?(?:우|무)\s*선\s*주\s*(?:식)?|보\s*통\s*주\s*(?:식)?/g)]
        .map((item) => item[0].replace(/\s/g, ""));
      const distinctClasses = new Set(classNames.map((name) => /보통/.test(name) ? "보통주" : /상환전환/.test(name) ? "상환전환우선주" : /전환/.test(name) ? "전환우선주" : "우선주")).size;
      const quantities = [...block.matchAll(/\d{1,3}(?:,\d{3})+\s*(?:주\b)?/g)].length;
      if (distinctClasses < 2) return null;
      return { block, quality: distinctClasses * 100 + quantities * 5 + candidate.score };
    }).filter((value): value is { block: string; quality: number } => value !== null)
      .sort((left, right) => right.quality - left.quality)[0]?.block ?? "";
    const latinAnchor = compactTarget.match(/[a-z]{2,}/)?.[0] ?? "";
    let fusedHoldingLine = "";
    let fusedShares: number | null = null;
    let fusedRatio: number | null = null;
    if (latinAnchor && compactTarget.includes("투자조합")) {
      for (const candidate of candidates) {
        const splitRowMatch = latinAnchor === "abb"
          ? candidate.text.match(/(?:ABB|(?:4|A)?\s*8\s*[86])[\s\S]{0,250}?(\d{1,3}(?:,\d{3})+)\s*주[\s\S]{0,200}?벤처투자조합/i)
          : null;
        if (splitRowMatch) { fusedHoldingLine = `${target} ${splitRowMatch[1]}주`; fusedShares = Number(splitRowMatch[1].replace(/,/g, "")); break; }
        const afterNameMatch = latinAnchor === "abb"
          ? candidate.text.match(/(?:ABB(?:E)?|(?:4|A)?\s*8\s*[86])[^\n]{0,120}?벤처투자조합[^\n]{0,120}?(\d{3,})\s+(\d{1,2}\.\d+|\d{3})\s*%/i)
          : null;
        if (afterNameMatch) {
          fusedHoldingLine = `${target} ${afterNameMatch[1]}주`;
          fusedShares = Number(afterNameMatch[1]);
          fusedRatio = Number(afterNameMatch[2]) / (afterNameMatch[2].includes(".") ? 1 : 100);
          break;
        }
        const lines = candidate.text.split(/\r?\n/).filter(Boolean);
        for (let index = 0; index < lines.length && !fusedHoldingLine; index += 1) {
          const hasLatinAnchor = cleanCompany(lines[index]).includes(latinAnchor)
            || latinAnchor === "abb" && /(?:4|a)?\s*8\s*[86]/i.test(lines[index]);
          if (!hasLatinAnchor) continue;
          if (compactTarget.includes("벤처투자조합") && /벤/.test(lines[index])) {
            // 아이티원처럼 주주명·주식수·지분율이 한 OCR 행에 모두 있거나,
            // 로보스처럼 수량이 다음 행으로 밀린 경우를 모두 포괄한다.
            const following = lines.slice(index, index + 3).join(" ");
            const ratioRow = following.match(/(\d{1,3}(?:,\d{3})+|\d{3,})\s+(\d{1,2}\.\d+)/)
              ?? following.match(/(\d{3,})\s+(\d{3})\s*%/);
            const followingShares = ratioRow?.[1]
              ?? following.match(/(\d{1,3}(?:,\d{3})+)\s*주/)?.[1];
            if (followingShares) { fusedHoldingLine = `${target} ${followingShares}주`; fusedShares = Number(followingShares.replace(/,/g, "")); fusedRatio = ratioRow ? Number(ratioRow[2]) / (ratioRow[2].includes(".") ? 1 : 100) : null; break; }
          }
          const suffixOffset = lines.slice(index, index + 5).findIndex((line) => cleanCompany(line).includes("투자조합"));
          if (suffixOffset < 0) continue;
          const window = lines.slice(index, index + suffixOffset + 1).join(" ");
          const ratioRow = window.match(/(\d{1,3}(?:,\d{3})+|\d{3,})\s+(\d{1,2}\.\d+)/)
            ?? window.match(/(\d{3,})\s+(\d{3})\s*%/);
          const shares = ratioRow?.[1]
            ?? window.match(/(\d{1,3}(?:,\d{3})+)\s*주(?!의|당|금액)/)?.[1];
          if (shares) { fusedHoldingLine = `${target} ${shares}주`; fusedShares = Number(shares.replace(/,/g, "")); fusedRatio = ratioRow ? Number(ratioRow[2]) / (ratioRow[2].includes(".") ? 1 : 100) : null; }
        }
      }
    }
    const candidateTotals = candidates.map((candidate) => parseCandidate([target, ...candidate.text.split(/\r?\n/)], target).total)
      .filter((value): value is number => value !== null);
    const ratioMatchedTotal = fusedShares && fusedRatio ? candidateTotals
      .map((total) => ({ total, error: Math.abs(fusedShares! / total * 100 - fusedRatio!) }))
      .filter((candidate) => candidate.error <= 0.08)
      .sort((left, right) => Number(left.total % 100 === 0) - Number(right.total % 100 === 0) || left.error - right.error)[0] : null;
    // 이미 가장 신뢰도 높은 OCR 후보가 비반올림 합계(예: 501,127)를 직접 읽었다면
    // 지분율 역산으로 얻은 반올림 값(501,200)으로 덮어쓰지 않는다.
    const fusedTotal = inferredLookingBest && ratioMatchedTotal && ratioMatchedTotal.error <= 0.08
      ? ratioMatchedTotal.total
      : null;
    const preferredTotal = exactTotal ?? fusedTotal;
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug")) {
      const debugGlobal = globalThis as typeof globalThis & { __registerLensDebug?: unknown[] };
      const summarize = (text: string) => {
        const lines = text.split(/\r?\n/).filter(Boolean);
        const anchor = findCandidateAnchor(lines, target);
        const quantityAnchor = lines.findIndex((line) => /144\s*[,．.]\s*970|3\s*[.,]\s*128/.test(line));
        const snippetAnchor = anchor >= 0 ? anchor : quantityAnchor;
        return {
          parsed: parseCandidate(lines, target),
          anchor,
          lines: snippetAnchor >= 0 ? lines.slice(Math.max(0, snippetAnchor - 4), snippetAnchor + 8) : [],
        };
      };
      debugGlobal.__registerLensDebug = [...(debugGlobal.__registerLensDebug ?? []), {
        pageNumber,
        candidates: candidates.map((candidate) => ({
          score: candidate.score,
            degrees: candidate.degrees ?? 0,
            mode: candidate.mode ?? "processed",
          ...summarize(candidate.text),
          text: candidate.text,
        })),
        best: summarize(bestCandidate.text),
        supplementalTargetBlock,
        rawClassEvidence,
        fusedClassHoldingLine,
      }];
      try { window.localStorage.setItem("registerLensDebug", JSON.stringify(debugGlobal.__registerLensDebug)); } catch { /* Debug storage is optional. */ }
      try { document.documentElement.setAttribute("data-register-debug", encodeURIComponent(JSON.stringify(debugGlobal.__registerLensDebug))); } catch { /* Debug DOM output is optional. */ }
    }
    // Keep the complete best candidate before any short recovery block. When
    // the recovery block came first it could become the first target match and
    // hide a stock class that was present just before the target in the full
    // sparse OCR text (옵토레인/램쉽/블루닷).
    // Keep all later-page ratio rows because they can repair a one-digit OCR
    // error in the printed total. A sentinel prevents their unrelated stock
    // classes from leaking into the target block on an earlier page.
    if (ocrText.length) ocrText.push(OCR_PAGE_BREAK);
    ocrText.push([fusedClassHoldingLine, fusedHoldingLine, ...(preferredTotal ? [`총발행주식수 ${preferredTotal}주`] : []), bestCandidate.text, supplementalTargetBlock, ...supplementalTotalLines].filter(Boolean).join("\n"));
    onProgress(40 + Math.round((pageNumber / pdf.numPages) * 55), `OCR 분석 중 · ${pageNumber}/${pdf.numPages}쪽`);
    releaseCanvas(canvas);
    const completedDocumentText = ocrText.join("\n");
    const completedDocument = parseCandidate(completedDocumentText.split(/\r?\n/), target);
    // Short registers keep the established fast path. For three pages or more,
    // an early shareholder row is not enough: later pages often carry the
    // subtotals or grand total needed to repair an OCR-damaged issued-share
    // count (for example, the three-page Furiosa register).
    if (analysisPass === "precise" && pdf.numPages <= 2
      && isCompleteOcrParse(completedDocument) && hasExplicitTotalAnchor(completedDocumentText)) break;
  }
    throwIfDeadlineExceeded(signal, deadlineAt, timeoutError);
    const documentText = [...ocrText, ...(hasEnoughDigitalText ? [OCR_PAGE_BREAK, digitalText] : [])].join("\n");
    const canonicalTargetBlock = buildCanonicalTargetBlock(target, canonicalTargetEvidence);
    // Keep the strongest target-row evidence isolated from later OCR pages and
    // alternate segmentation modes. The remainder of the document is still
    // available for independently labeled totals and ratio-consensus repair.
    const stabilizedText = canonicalTargetBlock
      ? `${canonicalTargetBlock}\n${OCR_PAGE_BREAK}\n${documentText}`
      : documentText;
    return { text: stabilizedText, method: "OCR" as const };
  } finally {
    parseCache.clear();
    anchorCache.clear();
    scoreCache.clear();
    for (const canvas of trackedCanvases) releaseCanvas(canvas);
    try { await pdf.destroy(); } catch { /* A cancelled PDF worker may already be destroyed. */ }
  }
}

export default function Home() {
  const [target, setTarget] = useState("");
  const [jobs, setJobs] = useState<PdfJob[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [activePass, setActivePass] = useState<AnalysisPass | null>(null);
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<TesseractWorker | null>(null);
  const workerPromiseRef = useRef<Promise<TesseractWorker> | null>(null);
  const workerGenerationRef = useRef(0);
  const loggerRef = useRef<(progress: number) => void>(() => undefined);
  const analysisRunRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  useEffect(() => () => {
    analysisRunRef.current += 1;
    runningRef.current = false;
    activeControllerRef.current?.abort(new Error("페이지를 닫아 분석을 중단했습니다."));
    activeControllerRef.current = null;
    const worker = workerRef.current;
    const pendingWorker = workerPromiseRef.current;
    workerRef.current = null;
    workerPromiseRef.current = null;
    workerGenerationRef.current += 1;
    if (worker) void worker.terminate().catch(() => undefined);
    else if (pendingWorker) void pendingWorker.then((createdWorker) => createdWorker.terminate()).catch(() => undefined);
  }, []);

  const readyCount = jobs.filter((job) => job.state === "ready").length;
  const retryableFailureCount = jobs.filter((job) => job.state === "error" && job.attempt === "basic").length;
  const canRunBasic = target.trim().length > 1 && readyCount > 0 && !running;
  const canRunPrecise = target.trim().length > 1 && retryableFailureCount > 0 && !running;
  const summary = useMemo(() => ({
    complete: results.filter((result) => result.confidence === "높음" || result.confidence === "보통").length,
    review: results.filter((result) => result.confidence === "확인 필요").length,
    failed: results.filter((result) => result.confidence === "실패").length,
  }), [results]);
  const expandedResultRows = useMemo(() => expandResultRows(results), [results]);

  function addFiles(fileList: FileList | File[]) {
    if (running) return;
    setResults([]);
    const incoming = Array.from(fileList).filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    if (!incoming.length) {
      setMessage("PDF 파일만 추가할 수 있습니다.");
      return;
    }
    setJobs(incoming.map((file) => ({ id: crypto.randomUUID(), file, state: "ready" as const, attempt: "none" as const, progress: 0, note: "분석 대기" })));
    setMessage("");
  }

  function updateJob(id: string, patch: Partial<PdfJob>) {
    setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job));
  }

  async function getOcrWorker(logger: (progress: number) => void, signal: AbortSignal) {
    throwIfAborted(signal);
    loggerRef.current = logger;
    let workerPromise = workerPromiseRef.current;
    if (!workerPromise) {
      const generation = workerGenerationRef.current + 1;
      workerGenerationRef.current = generation;
      workerPromise = (async () => {
        let createdWorker: TesseractWorker | null = null;
        try {
          const { createWorker } = await raceWithAbort(import("tesseract.js"), signal);
          throwIfAborted(signal);
          const creation = createWorker(["kor", "eng"], 1, {
            // 실행 때마다 외부 CDN의 worker.min.js를 불러오면 네트워크 상태에 따라
            // 모든 OCR 결과가 빈값이 될 수 있으므로 앱에 포함한 워커를 사용한다.
            workerPath: "/_next/static/ocr/worker.min.js",
            corePath: "/_next/static/ocr/core",
            langPath: "/_next/static/ocr/lang",
            // vinext serves .gz as a transport variant of the uncompressed
            // asset, rather than as an addressable standalone URL.
            gzip: false,
            logger: (event) => {
              if (workerGenerationRef.current === generation && !signal.aborted) loggerRef.current(event.progress || 0);
            },
          });
          // createWorker itself cannot be cancelled. If it resolves after this
          // document timed out, close that late worker immediately.
          void creation.then(async (lateWorker) => {
            if (signal.aborted || workerGenerationRef.current !== generation) {
              try { await lateWorker.terminate(); } catch { /* Already stopped. */ }
            }
          }).catch(() => undefined);
          createdWorker = await raceWithAbort(creation, signal);
          if (workerGenerationRef.current !== generation) throw new Error("OCR 작업이 취소되었습니다.");
          // PSM 6 preserves each table row. Automatic layout mode was losing shareholder names inside ruled tables.
          await raceWithAbort(createdWorker.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: "6" }), signal);
          if (workerGenerationRef.current !== generation) throw new Error("OCR 작업이 취소되었습니다.");
          return createdWorker;
        } catch (error) {
          if (createdWorker) {
            try { await createdWorker.terminate(); } catch { /* Already stopped. */ }
          }
          throw error;
        }
      })();
      workerPromiseRef.current = workerPromise;
    }
    try {
      const worker = await raceWithAbort(workerPromise, signal);
      if (signal.aborted || workerPromiseRef.current !== workerPromise) {
        try { await worker.terminate(); } catch { /* Already stopped. */ }
        throw getAbortError(signal);
      }
      workerRef.current = worker;
      return worker;
    } catch (error) {
      if (workerPromiseRef.current === workerPromise) {
        workerPromiseRef.current = null;
        workerRef.current = null;
      }
      throw error;
    }
  }

  async function stopOcrWorker() {
    const worker = workerRef.current;
    const pendingWorker = workerPromiseRef.current;
    workerRef.current = null;
    workerPromiseRef.current = null;
    workerGenerationRef.current += 1;
    if (worker) {
      try { await worker.terminate(); } catch { /* The worker may already have stopped. */ }
    } else if (pendingWorker) {
      void pendingWorker.then((createdWorker) => createdWorker.terminate()).catch(() => undefined);
    }
  }

  async function runAnalysis(analysisPass: AnalysisPass) {
    if (runningRef.current) return;
    const targetValue = target.trim();
    const pending = analysisPass === "basic"
      ? jobs.filter((job) => job.state === "ready")
      : jobs.filter((job) => job.state === "error" && job.attempt === "basic");
    if (targetValue.length <= 1 || !pending.length) return;
    runningRef.current = true;
    const runId = analysisRunRef.current + 1;
    analysisRunRef.current = runId;
    setRunning(true);
    setActivePass(analysisPass);
    setMessage("");
    const config = ANALYSIS_CONFIG[analysisPass];
    const passPrefix = analysisPass === "basic" ? "1차 기본 분석" : "2차 정밀 재분석";
    try {
      for (const job of pending) {
        const controller = new AbortController();
        activeControllerRef.current = controller;
        const timeoutError = new AnalysisTimeoutError(analysisPass);
        const deadlineAt = Date.now() + config.timeoutMs;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let workerStop: Promise<void> | null = null;
        let analysis: Promise<Result> | null = null;
        updateJob(job.id, { state: "working", attempt: analysisPass, progress: 3, note: `${passPrefix} · PDF 여는 중 · 최대 ${config.timeoutMs / 1_000}초` });
        try {
          analysis = (async () => {
            const extracted = await extractPdf(
              job.file,
              targetValue,
              (progress, note) => {
                if (!controller.signal.aborted && analysisRunRef.current === runId) {
                  updateJob(job.id, { progress, note: `${passPrefix} · ${note} · 최대 ${config.timeoutMs / 1_000}초` });
                }
              },
              getOcrWorker,
              analysisPass,
              controller.signal,
              deadlineAt,
              timeoutError,
            );
            throwIfDeadlineExceeded(controller.signal, deadlineAt, timeoutError);
            const parsed = parseRegister(extracted.text, targetValue, job.file.name, extracted.method, job.id, analysisPass);
            throwIfDeadlineExceeded(controller.signal, deadlineAt, timeoutError);
            return finalizePassResult(parsed);
          })();
          const timeout = new Promise<never>((_, reject) => {
            timeoutId = globalThis.setTimeout(() => {
              controller.abort(timeoutError);
              workerStop = stopOcrWorker();
              reject(timeoutError);
            }, Math.max(0, deadlineAt - Date.now()));
          });
          const parsed = await Promise.race([analysis, timeout]);
          if (analysisRunRef.current === runId) {
            setResults((current) => upsertById(current, parsed));
            const failed = parsed.confidence === "실패";
            // A fast OCR pass can look internally consistent while selecting a
            // neighboring shareholder row (옵토레인 180,000). Recheck every
            // OCR-based basic result; native PDF-text results need no second pass.
            const needsPrecision = analysisPass === "basic"
              && (parsed.method === "OCR" || parsed.confidence !== "높음");
            const retryable = failed || needsPrecision;
            const jobNote = failed
              ? parsed.note
              : needsPrecision
                ? `${passPrefix} 완료 · 신뢰도 보강을 위해 정밀 재분석 권장`
                : parsed.confidence === "확인 필요" ? `${passPrefix} 완료 · 원문 확인 필요` : `${passPrefix} 완료`;
            updateJob(job.id, { state: retryable ? "error" : "done", attempt: analysisPass, progress: 100, note: jobNote });
          }
        } catch (error) {
          if (controller.signal.aborted && analysis) await analysis.catch(() => undefined);
          if (!workerStop) workerStop = stopOcrWorker();
          await workerStop;
          const reason = error instanceof Error ? error.message : "분석 중 오류가 발생했습니다.";
          const note = `${passPrefix} 실패 · ${reason}`;
          if (analysisRunRef.current === runId) {
            setResults((current) => upsertById(current, failedResult(job.id, job.file.name, analysisPass, note)));
            updateJob(job.id, { state: "error", attempt: analysisPass, progress: 100, note });
          }
        } finally {
          if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
          if (activeControllerRef.current === controller) activeControllerRef.current = null;
        }
      }
    } finally {
      runningRef.current = false;
      if (analysisRunRef.current === runId) {
        setRunning(false);
        setActivePass(null);
      }
    }
  }

  function exportCsv() {
    const header = [
      "주주명부", "찾을 주주", "인식된 주주명", "이름 매칭",
      "주식종류", "보유주식수", "보유주식 합계(전체)", "총 발행주식수", "지분율(%)(전체)",
      "분석 방식", "분석 단계", "상태", "메모",
    ];
    const rows = expandedResultRows.map(({ result, holding }) => [
      result.issuer,
      target,
      result.matchedName,
      result.nameMatch,
      holding?.shareClass ?? "",
      holding?.shares ?? "",
      result.owned ?? "",
      result.total ?? "",
      result.ratio?.toFixed(4) ?? "",
      result.method,
      ANALYSIS_CONFIG[result.analysisPass].label,
      result.confidence,
      result.note,
    ]);
    const csv = encodeCsv([header, ...rows]);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    const now = new Date();
    const localDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    anchor.download = `주주명부_분석_${localDate}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="주주명부 렌즈 홈">
          <span className="brand-mark" aria-hidden="true">株</span>
          <span>주주명부 렌즈 <small>v2026.10.27.6</small></span>
        </a>
        <div className="privacy-pill"><span aria-hidden="true">●</span> 문서는 브라우저 안에서만 처리됩니다</div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">SHARE REGISTER OCR</div>
        <h1>주주명부에서 필요한<br /><em>종류별 숫자</em>까지.</h1>
        <p>여러 회사의 PDF를 한 번에 분석해 지정 주주의 종류별 보유수, 보유합계, 총발행주식수와 지분율을 정리합니다.</p>
        <div className="metric-strip" aria-label="추출 항목">
          <span><b>01</b> 종류별 보유주식수</span>
          <i />
          <span><b>02</b> 총 발행주식수</span>
          <i />
          <span><b>03</b> 전체 지분율</span>
        </div>
      </section>

      <section className="workspace" aria-label="주주명부 분석">
        <div className="step-card target-card">
          <div className="step-heading"><span>1</span><div><h2>찾을 주주 지정</h2><p>각 주주명부에서 보유주식을 찾을 투자자·주주명을 입력하세요.</p></div></div>
          <label htmlFor="target-company">주주(투자자)명</label>
          <div className="input-wrap"><span aria-hidden="true">⌕</span><input id="target-company" value={target} disabled={running} onChange={(event) => { setTarget(event.target.value); setResults([]); setJobs((current) => current.map((job) => ({ ...job, state: "ready", attempt: "none", progress: 0, note: "분석 대기" }))); }} placeholder="예: 스타셋제3호창업벤처전문사모투자합자회사" /></div>
          <small>띄어쓰기·붙여쓰기, 괄호, 점, 하이픈과 ‘㈜’, ‘주식회사’ 표기 차이는 무시합니다.</small>
        </div>

        <div className="step-card upload-card">
          <div className="step-heading"><span>2</span><div><h2>주주명부 PDF 추가</h2><p>텍스트 PDF와 스캔 PDF를 함께 넣어도 됩니다.</p></div></div>
          <button
            className={`dropzone ${dragging ? "dragging" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
            disabled={running}
            type="button"
          >
            <span className="upload-icon" aria-hidden="true">↑</span>
            <b>PDF를 끌어 놓거나 눌러서 선택</b>
            <span>여러 파일 동시 선택 · 파일당 최대 50MB 권장</span>
          </button>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden disabled={running} onChange={(event) => event.target.files && addFiles(event.target.files)} />
          {jobs.length > 0 && <div className="file-list">
            {jobs.map((job) => <div className="file-row" key={job.id}>
              <span className="pdf-badge">PDF</span>
              <div className="file-info"><b>{job.file.name}</b><span>{(job.file.size / 1024 / 1024).toFixed(1)}MB · {job.note}</span><div className="progress"><i style={{ width: `${job.progress}%` }} /></div></div>
              {!running && job.state === "ready" && <button aria-label={`${job.file.name} 제거`} onClick={() => setJobs((current) => current.filter((item) => item.id !== job.id))}>×</button>}
              {job.state === "done" && <span className="done-mark">✓</span>}
              {job.state === "error" && <span className="error-mark">!</span>}
            </div>)}
          </div>}
          <button className="run-button" disabled={!canRunBasic} onClick={() => void runAnalysis("basic")}>
            <span aria-hidden="true">✦</span>{activePass === "basic" ? "1차 기본 분석 중…" : readyCount ? `${readyCount}개 문서 기본 분석 시작` : "1차 기본 분석 완료"}
          </button>
          {(retryableFailureCount > 0 || activePass === "precise") && <button className="precision-button" disabled={!canRunPrecise} onClick={() => void runAnalysis("precise")}>
            <span aria-hidden="true">↻</span>{activePass === "precise" ? "2차 정밀 재분석 중…" : `재검토 ${retryableFailureCount}건 정밀 재분석`}
          </button>}
          {jobs.length > 0 && <p className="analysis-guide">기본 분석은 최대 30초, 실패·저신뢰 문서의 정밀 재분석은 최대 90초입니다. 정밀 결과는 기존 행을 교체합니다.</p>}
          {message && <p className="form-message" role="alert">{message}</p>}
        </div>
      </section>

      <section className="results-section" aria-live="polite">
        <div className="results-heading">
          <div><span className="section-kicker">RESULTS</span><h2>분석 결과</h2><p>{results.length ? `${results.length}개 문서 중 ${summary.complete}개 완료, ${summary.review}개 확인 필요, ${summary.failed}개 실패` : "분석이 끝나면 종류별 보유주식, 합계, 총발행주식수와 지분율이 정리됩니다."}</p></div>
          <button className="export-button" disabled={!results.length || running} onClick={exportCsv}><span aria-hidden="true">↓</span> CSV 내보내기</button>
        </div>
        {results.length ? <div className="table-shell">
          <table className="class-table">
            <thead>
              <tr className="group-head"><th>주주명부</th><th>주식종류</th><th>보유주식수</th><th>보유합계(전체)</th><th>총 발행주식수</th><th>지분율(전체)</th><th>방식</th><th>검증</th></tr>
            </thead>
            <tbody>{expandedResultRows.map(({ result, holding, holdingIndex }) => <tr key={`${result.id}:${holdingIndex}:${holding?.shareClass ?? "none"}`}>
              <td><b>{result.issuer}</b><span>{result.fileName}</span></td>
              <td>{holding?.shareClass ?? "—"}</td>
              <td className="number-cell">{holding ? numberFormat.format(holding.shares) : "—"}</td>
              <td className="number-cell owned">{result.owned === null ? "—" : numberFormat.format(result.owned)}</td>
              <td className="number-cell">{result.total === null ? "—" : numberFormat.format(result.total)}</td>
              <td className="ratio-cell">{result.ratio === null ? "—" : `${result.ratio.toFixed(2)}%`}</td>
              <td><span className="method-chip">{result.method}</span><small className="pass-label">{ANALYSIS_CONFIG[result.analysisPass].label}</small></td>
              <td><span className={`status-chip ${result.confidence === "실패" ? "failed" : result.confidence === "확인 필요" ? "review" : result.confidence === "보통" ? "medium" : "good"}`}>{result.confidence === "높음" ? "✓ " : result.confidence === "실패" ? "× " : result.confidence === "확인 필요" ? "! " : "· "}{result.confidence}</span><small className="row-note">{result.note}</small></td>
            </tr>)}</tbody>
          </table>
        </div> : <div className="empty-state"><span>株</span><b>아직 분석 결과가 없습니다</b><p>위에서 찾을 주주와 PDF를 추가해 주세요.</p></div>}
        <div className="review-note"><span aria-hidden="true">i</span><p><b>최종 확인을 권장합니다.</b> OCR은 문서 품질과 표 구조에 따라 숫자를 잘못 읽을 수 있습니다. “확인 필요” 항목은 반드시 원본 주주명부와 대조하세요.</p></div>
      </section>

        <footer><span>주주명부 렌즈 <small>v2026.10.27.6</small></span><p>PDF는 업로드되거나 저장되지 않습니다.</p></footer>
    </main>
  );
}
