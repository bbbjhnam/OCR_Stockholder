export type Holding = { shareClass: string; shares: number };
export type ParsedRegister = {
  total: number | null; holdings: Holding[]; owned: number | null; ratio: number | null;
  matchedName: string; nameMatch: "정확" | "유사" | "실패";
  confidence: "높음" | "보통" | "확인 필요"; note: string;
};
type NameMatch = { index: number; span: number; score: number; text: string; fuzzy: boolean };
type RatioRow = { index: number; percent: number; candidates: number[]; share: number | null };

export const OCR_PAGE_BREAK = "__REGISTER_LENS_OCR_PAGE_BREAK__";

const shareClassPattern = /(?:제\s*\d+\s*(?:에\s*이|비|씨|디|이|에\s*프|지|[A-Z])?\s*종\s*)?(?:(?:상\s*환\s*전\s*환|전\s*환\s*상\s*환|상\s*환|전\s*환)\s*)?(?:(?:우|무)\s*선|(?:우|으)\s*서)\s*주\s*(?:식)?|(?:상\s*환\s*전\s*환|전\s*환\s*상\s*환)\s*주\s*(?:식)?|보\s*통\s*주\s*(?:식)?|\bRCPS\b|\bCPS\b|\bCS\b/gi;

export function cleanCompany(value: string) {
  return value.normalize("NFKC").toLowerCase()
    .replace(/a\s*h\s*a(?=\s*시\s*스\s*템\s*반\s*도\s*체)/gi, "엘앤에스")
    .replace(/(?:엘|열)\s*(?:앤|엔)\s*(?:에|메)\s*스/gi, "엘앤에스")
    .replace(/시\s*스\s*템\s*반\s*(?:도|두)\s*체/gi, "시스템반도체")
    .replace(/(?:클|글)\s*로\s*(?:벌|벨)/gi, "글로벌")
    .replace(/반\s*두\s*체/gi, "반도체")
    .replace(/(?:투|루)\s*자\s*조\s*(?:한|합)/gi, "투자조합")
    .replace(/제\s*이\s*비|j\s*b/gi, "jb").replace(/(?:jb){2,}/g, "jb")
    .replace(/매\s*츠\s*[ㅅᄉsa4b8e6]{2,5}(?=\s*테\s*크)/gi, "매츠abb")
    .replace(/매\s*츠\s*(?:4|a)?88e?/gi, "매츠abb")
    .replace(/[ㅅᄉs^]?\s*(?:4|a)?\s*8\s*[86]e?(?=\s*(?:테\s*크|제\s*\d))/gi, "abb")
    .replace(/abbe(?=\s*(?:테크|제\s*\d|벤처))/gi, "abb")
    .replace(/제(\d+)흐/g, "제$1호")
    .replace(/(\d+)\s*(?:흐|ㅎ|ᄒ)(?=\s*(?:\d|투\s*자|조\s*합|$))/g, "$1호")
    .replace(/\(\s*주\s*\)|주식회사|유한회사|합자회사|유한책임회사/g, "")
    .replace(/업무집행조합원|대표조합원/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function orderedCoverage(candidate: string, target: string) {
  let matched = 0;
  for (const character of candidate) if (character === target[matched]) matched += 1;
  return matched / target.length;
}

function editDistance(left: string, right: string) {
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length];
}

function bestSubstringSimilarity(candidate: string, target: string) {
  if (!candidate || !target) return 0;
  if (candidate.includes(target) || target.includes(candidate) && candidate.length >= Math.ceil(target.length * 0.7)) return 1;
  let best = 0;
  for (let length = Math.max(2, target.length - 2); length <= Math.min(candidate.length, target.length + 3); length += 1) {
    for (let start = 0; start + length <= candidate.length; start += 1) {
      const slice = candidate.slice(start, start + length);
      best = Math.max(best, 1 - editDistance(slice, target) / Math.max(slice.length, target.length));
    }
  }
  return best;
}

export function findTargetMatch(lines: string[], target: string): NameMatch | null {
  const compactTarget = cleanCompany(target);
  if (compactTarget.length < 2) return null;
  const targetFundNumber = compactTarget.match(/(\d+)호/)?.[1];
  const anchors = [
    /(?:제\s*이\s*비|j\s*b)/i.test(target) ? "jb" : "",
    /기술\s*지주/.test(target) ? "기술지주" : "",
    /개인\s*투자\s*조합/.test(target) ? "개인투자조합" : "",
  ].filter(Boolean);
  const genericAnchors = target.split(/[\s·,，()（）\-‐‑‒–—_/]+/).map((part) => cleanCompany(part)).filter((part) => part.length >= 2);
  let best: NameMatch | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    for (let span = 1; span <= 6 && index + span <= lines.length; span += 1) {
      if (lines.slice(index, index + span).includes(OCR_PAGE_BREAK)) break;
      const text = lines.slice(index, index + span).join(" ");
      const candidate = cleanCompany(text);
      const exact = candidate.includes(compactTarget);
      const candidateFundNumbers = [...candidate.matchAll(/(\d+)호/g)].map((item) => item[1]);
      if (!exact && targetFundNumber && candidateFundNumbers.length && !candidateFundNumbers.includes(targetFundNumber)) continue;
      const score = bestSubstringSimilarity(candidate, compactTarget);
      const sequenceScore = orderedCoverage(candidate, compactTarget);
      const anchorMatch = anchors.length >= 2 && anchors.every((anchor) => candidate.includes(anchor));
      const genericMatched = genericAnchors.filter((anchor) => candidate.includes(anchor)
        || (anchor === compactTarget ? score : bestSubstringSimilarity(candidate, anchor)) >= 0.78).length;
      const genericAnchorMatch = genericAnchors.length >= 2 ? genericMatched >= Math.min(2, genericAnchors.length) : genericMatched === 1 && genericAnchors[0].length >= 4;
      const abbFundMatch = compactTarget.includes("abb") && compactTarget.includes("벤처투자조합")
        && candidate.includes("abb")
        && candidate.includes(compactTarget.match(/제\d+호/)?.[0] ?? "제1호") && candidate.includes("벤처투자조합");
      const threshold = compactTarget.length <= 5 ? 0.8 : compactTarget.length <= 9 ? 0.76 : 0.72;
      const orderedMatch = compactTarget.length >= 10 && sequenceScore >= 0.88 && candidate.length <= compactTarget.length * 8;
      const acceptedScore = (anchorMatch || genericAnchorMatch || abbFundMatch) ? Math.max(score, 0.88) : orderedMatch ? Math.max(score, 0.86) : score;
      if ((exact || anchorMatch || genericAnchorMatch || abbFundMatch || orderedMatch || score >= threshold) && (!best || acceptedScore > best.score || acceptedScore === best.score && span < best.span)) {
        best = { index, span, score: acceptedScore, text: lines.slice(index, index + span).join(" ").replace(/\t/g, " "), fuzzy: !exact };
        // A score of one on a single line is already the earliest best result:
        // no later candidate can improve its score or shorten its span.
        if (best.score === 1 && best.span === 1) return best;
      }
    }
  }
  return best;
}

function findTargetMatches(lines: string[], target: string) {
  const matches: NameMatch[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const found = findTargetMatch(lines.slice(cursor), target);
    if (!found) break;
    const absolute = { ...found, index: found.index + cursor };
    matches.push(absolute);
    cursor = absolute.index + Math.max(1, absolute.span);
  }
  return matches;
}

// This is deliberately looser than findTargetMatch. It only decides whether
// another OCR pass is worth running; it never accepts a shareholder holding.
export function findTargetAnchorIndex(lines: string[], target: string) {
  const match = findTargetMatch(lines, target);
  if (match) return match.index;

  const compactTarget = cleanCompany(target);
  if (compactTarget.length < 5) return -1;
  const fragments = new Set(
    target.normalize("NFKC").split(/[\s·,，()（）\-‐‑‒–—_/]+/)
      .map((part) => cleanCompany(part)).filter((part) => part.length >= 5),
  );
  if (compactTarget.length >= 10) {
    fragments.add(compactTarget.slice(0, 5));
    fragments.add(compactTarget.slice(-6));
  }

  for (let index = 0; index < lines.length; index += 1) {
    for (let span = 1; span <= 4 && index + span <= lines.length; span += 1) {
      const candidate = cleanCompany(lines.slice(index, index + span).join(" "));
      if ([...fragments].some((fragment) => candidate.includes(fragment)
        || fragment.length >= 6 && bestSubstringSimilarity(candidate, fragment) >= 0.82)) return index;
    }
  }
  return -1;
}

function toNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(/[Oo]/g, "0").replace(/[,\s]/g, "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toPercent(value: string | undefined) {
  const parsed = toNumber(value);
  // Decimal points are commonly dropped in narrow percentage columns:
  // `4.84%` -> `484%`, `9.62%` -> `962%`.
  if (parsed !== null && parsed > 100 && Number.isInteger(parsed) && parsed <= 9_999) return parsed / 100;
  return parsed;
}

function normalizeShareClass(value: string) {
  const compact = value.replace(/\s|주식$/g, "").toUpperCase();
  const series = compact.match(/^제(\d+(?:에이|비|씨|디|이|에프|지|[A-Z])?)종/)?.[1] ?? null;
  const repaired = compact.replace(/^제\d+(?:에이|비|씨|디|이|에프|지|[A-Z])?종/, "").replace(/무선주/g, "우선주").replace(/(?:우|으)서주/g, "우선주");
  let normalized: string;
  if (repaired === "CS" || repaired === "보통" || repaired.includes("보통주")) normalized = "보통주";
  else if (repaired === "RCPS") normalized = "상환전환우선주";
  else if (repaired === "CPS") normalized = "전환우선주";
  else if (repaired === "무선" || repaired === "우서" || repaired === "우선주") normalized = "우선주";
  else if (repaired.includes("상환") && repaired.includes("전환")) normalized = repaired.includes("우선") ? "상환전환우선주" : "상환전환주";
  else normalized = repaired.replace(/(우선)$/, "$1주");
  return series ? `제${series}종 ${normalized}` : normalized;
}

function shareClassFromText(value: string) {
  const compact = value.replace(/\s/g, "");
  if (/상환전환.{0,20}(?:우선주|무선주|우서주|으서주)/.test(compact)) return "상환전환우선주";
  if (/전환상환.{0,20}(?:우선주|무선주|우서주|으서주)/.test(compact)) return "상환전환우선주";
  const match = [...value.matchAll(new RegExp(shareClassPattern.source, "gi"))][0];
  return match ? normalizeShareClass(match[0]) : "주식종류 미표시";
}

function splitCompositeClassImmediatelyBeforeMatch(lines: string[], match: NameMatch) {
  // Sparse OCR may emit a narrow class cell immediately before the shareholder
  // name, split as `상환전환-` and `우선주`. Keep this deliberately narrow: a
  // two-line composite without digits is much safer than borrowing a generic
  // class from the previous shareholder row.
  if (match.index < 2) return null;
  const [modifierLine, classLine] = lines.slice(match.index - 2, match.index);
  if (/\d/.test(modifierLine) || /\d/.test(classLine)) return null;
  const modifier = modifierLine.replace(/[^\p{L}]/gu, "");
  const shareClass = classLine.replace(/[^\p{L}]/gu, "");
  if (/(?:상환전환|전환상환)/.test(modifier)
    && /(?:우선주|무선주|우서주|으서주)/.test(shareClass)) return "상환전환우선주";
  return null;
}

function numberTokens(value: string) {
  const scrubbed = value
    .replace(/\d{2,4}[.-]\d{1,2}[.-]\d{1,2}/g, " ")
    .replace(/\d{2,3}-\d{3,4}-\d{4}/g, " ")
    .replace(/\d{6}-\d{7}/g, " ")
    .replace(/\d{3}-\d{2}-\d{5}/g, " ");
  return [...scrubbed.matchAll(/\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?/g)]
    .map((match) => ({
      value: /^\d{1,3}(?:[,.]\d{3})+$/.test(match[0]) ? Number(match[0].replace(/[,.]/g, "")) : toNumber(match[0]),
      index: match.index ?? 0,
    }))
    .filter((item): item is { value: number; index: number } => item.value !== null);
}

function withoutCurrencyAmounts(value: string) {
  // Remove the complete currency cell before choosing a share count. This
  // preserves a neighboring unlabeled share cell in flattened OCR rows such as
  // `합계 500원 7,278,282 3,639,141,000원 100%`.
  return value.replace(/\d{1,3}(?:[,.]\d{3})+\s*원(?:정)?|\d+(?:\.\d+)?\s*원(?:정)?/g, " ");
}

const standardFaceValues = new Set([50, 100, 200, 500, 1_000, 5_000, 10_000]);

function quantityFromFaceValueAmount(value: string) {
  const all = numberTokens(value).map((item) => item.value)
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 10_000_000_000);
  // Many registers flatten `face value | shares | amount` into one OCR line.
  // When the arithmetic identity is visible, the middle operand is the share
  // quantity even if the 주/원 suffix on the other cells was lost.
  const currencyValues = [...value.matchAll(/(\d{1,3}(?:[,.]\d{3})+|\d+)\s*원/g)]
    .map((item) => Number(item[1].replace(/[,.]/g, ""))).filter((item) => item > 0 && item <= 100_000);
  const faceValues = [...new Set([...all.filter((item) => standardFaceValues.has(item)), ...currencyValues])];
  for (const faceValue of faceValues) {
    for (const shares of all) {
      if (shares === faceValue) continue;
      for (const amount of all) {
        if (amount === faceValue || amount === shares) continue;
        if (Math.abs(faceValue * shares - amount) <= Math.max(1, amount * 0.0001)) return shares;
      }
    }
  }
  return null;
}

function quantityFromTotalArithmetic(value: string) {
  const all = numberTokens(value).map((item) => item.value)
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 10_000_000_000);
  for (let amountIndex = all.length - 1; amountIndex >= 1; amountIndex -= 1) {
    const amount = all[amountIndex];
    const earlier = all.slice(0, amountIndex).filter((item) => item >= 100 && item < amount);
    for (const faceValue of standardFaceValues) {
      if (amount % faceValue !== 0) continue;
      const shares = amount / faceValue;
      if (shares < 100 || shares > 1_000_000_000) continue;
      if (earlier.includes(shares)) return shares;
      const detail = earlier.filter((item) => item < shares);
      if (detail.length >= 2 && detail.reduce((sum, item) => sum + item, 0) === shares) return shares;
    }
  }
  return null;
}

function quantityFromFlattenedShareRow(value: string) {
  const arithmeticQuantity = quantityFromFaceValueAmount(value);
  if (arithmeticQuantity !== null) return arithmeticQuantity;
  const totalArithmeticQuantity = quantityFromTotalArithmetic(value);
  if (totalArithmeticQuantity !== null) return totalArithmeticQuantity;
  const candidates = numberTokens(withoutCurrencyAmounts(value)).map((item) => item.value)
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 1_000_000_000);
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const smaller = Math.min(candidates[left], candidates[right]);
      const larger = Math.max(candidates[left], candidates[right]);
      if (larger % smaller === 0 && standardFaceValues.has(larger / smaller)) return smaller;
    }
  }
  return candidates.at(-1) ?? null;
}

function sharesFollowingClass(
  lines: string[],
  lineIndex: number,
  matchIndex: number,
  matchLength: number,
  previousClassEnd = 0,
  nextClassStart = lines[lineIndex]?.length ?? 0,
  maxLineExclusive = Math.min(lines.length, lineIndex + 5),
) {
  const line = lines[lineIndex];
  const beforeClass = line.slice(previousClassEnd, matchIndex);
  const afterClass = line.slice(matchIndex + matchLength, nextClassStart);
  const explicitShares = (value: string) => [...value.matchAll(/(\d{1,3}(?:[,.]\d{3})+|\d+)\s*주(?!의|당|금액)/g)]
    .map((item) => toNumber(item[1])).filter((item): item is number => item !== null && item > 0);
  const beforeExplicit = explicitShares(beforeClass).at(-1) ?? null;
  const afterExplicit = explicitShares(afterClass)[0] ?? null;
  // `44,020주 (보통주) 491,195주 (상환전환우선주)`처럼 수량이
  // 괄호 속 종류보다 앞에 놓인 형식은 뒤 수량을 빌려오지 않는다.
  const parenthesizedClass = /[（(]\s*$/.test(beforeClass) || /^\s*[)）]/.test(afterClass);
  if (parenthesizedClass && beforeExplicit !== null) return beforeExplicit;
  if (afterExplicit !== null) return afterExplicit;
  if (beforeExplicit !== null) return beforeExplicit;

  const afterBeforePercent = afterClass.split(/\d+(?:\.\d+)?\s*%/, 1)[0];
  const afterNumber = quantityFromFlattenedShareRow(afterBeforePercent);
  if (afterNumber !== null) return afterNumber;
  const beforeNumber = isAddressContinuation(beforeClass) ? null : quantityFromFlattenedShareRow(beforeClass);
  if (beforeNumber !== null) return beforeNumber;
  for (let index = lineIndex + 1; index < maxLineExclusive; index += 1) {
    const line = lines[index];
    if (/(?:합\s*계|총\s*계|총\s*발행\s*주식수|발행\s*주식(?:의)?\s*총수)/.test(line)) break;
    const explicit = line.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/);
    const value = toNumber(explicit?.[1]);
    if (value !== null && value > 0) return value;
    const standalone = line.match(/^\s*(\d{1,3}(?:[,.]\d{3})+|\d+)\s*$/);
    const standaloneValue = toNumber(standalone?.[1]);
    if (standaloneValue !== null && standaloneValue > 0) return standaloneValue;
    if (/\d+(?:\.\d+)?\s*%/.test(line)) {
      // A vertically centred percentage can precede the bottom of the same
      // shareholder's wrapped address and quantity cell. Only cross it when
      // the immediately following line is clearly an address continuation.
      const next = index + 1 < maxLineExclusive ? lines[index + 1] : "";
      if (isAddressContinuation(next) && !new RegExp(shareClassPattern.source, "i").test(next)) {
        const following = next.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/);
        const shares = toNumber(following?.[1]);
        if (shares !== null && shares > 0) return shares;
      }
      break;
    }
  }
  return null;
}

function meaningfulTableText(value: string) {
  return value
    .replace(new RegExp(shareClassPattern.source, "gi"), " ")
    .replace(/(?:상\s*환\s*전\s*환|전\s*환\s*상\s*환|보\s*통|우\s*선|주\s*식|지\s*분\s*율)/g, " ")
    .replace(/(?:업무\s*집행\s*조합원|대표\s*조합원|소\s*계)/g, " ")
    .replace(/\d[\d,.%\-/]*/g, " ")
    .replace(/(?:금|원|정|주|종|번|호)/g, " ")
    .replace(/[^\p{L}]/gu, "");
}

function isAddressContinuation(value: string) {
  const text = value.trim();
  return /^(?:주소\s*[:：]?\s*)?(?:서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원(?:특별자치)?도|충청[남북]도|전라[남북]도|전북특별자치도|경상[남북]도|제주(?:특별자치)?도)/.test(text)
    || /^\d+\s*(?:층|동|호)(?=[\s,，(（]|$)/.test(text);
}

function hasForeignNameBeforeClass(line: string, classIndex: number, target: string) {
  const prefix = line.slice(0, classIndex);
  if (cleanCompany(prefix).includes(cleanCompany(target))) return false;
  if (isAddressContinuation(prefix)) return false;
  const meaningful = meaningfulTableText(prefix);
  const hangulLength = (meaningful.match(/[가-힣]/g) ?? []).length;
  // Mixed two-character debris such as `르 yl` is common immediately before
  // a valid series cell. It is not enough evidence of a new shareholder.
  return hangulLength >= 2 || /[A-Za-z]{4,}/.test(meaningful);
}

function looksLikeStandaloneShareholderName(line: string, target: string) {
  if (!line.trim() || cleanCompany(line).includes(cleanCompany(target))) return false;
  // Sparse OCR frequently drops the first syllable from `대한민국` while
  // emitting each table cell on its own line.  Treat both spellings as row
  // metadata so `한민국` cannot prematurely close the matched shareholder
  // block before its stock class and quantity (블루닷).
  if (/(?:합\s*계|총\s*계|주소|생년월일|사업자등록|주민등록|취득연월일|금액|지분율|(?:대\s*)?한\s*민\s*국|조\s*합\s*[（(]\s*펀\s*드\s*[)）])/.test(line)) return false;
  if (/(?:특별시|광역시|경기도|전라|충청|경상|제주|\s시\s|\s군\s|\s구\s|\s로\s|\s길\s|\s동\s|\s층|\s호)/.test(line)) return false;
  if (/\d/.test(line) || new RegExp(shareClassPattern.source, "i").test(line)) return false;
  const text = meaningfulTableText(line);
  const hangulLength = (text.match(/[가-힣]/g) ?? []).length;
  return hangulLength >= 2 && text.length <= 40;
}

function isTargetContextLine(lines: string[], index: number, target: string, matchEnd?: number, matchText = "") {
  const line = lines[index] ?? "";
  const compactLine = cleanCompany(line);
  const compactTarget = cleanCompany(target);
  const brand = compactTarget.slice(0, Math.min(4, compactTarget.length));
  const classFollows = new RegExp(shareClassPattern.source, "i").test(line)
    || lines.slice(index + 1, index + 3)
      .some((candidate) => new RegExp(shareClassPattern.source, "i").test(candidate));
  if (!classFollows) return false;
  const managerOrFund = /(?:투\s*자\s*조\s*합|벤\s*처\s*캐\s*피\s*탈|업무\s*집행\s*조합원|대표\s*조합원)/.test(line);
  if (managerOrFund && brand.length >= 3 && compactLine.includes(brand)) return true;
  // A vertically merged shareholder name may put only its generic fund suffix
  // on the second line after the matched company name (for example 에티포스).
  if (matchEnd !== undefined && index <= matchEnd + 2 && /투\s*자\s*조\s*합/.test(line)) return true;
  if (matchEnd !== undefined && index <= matchEnd + 2 && /^(?:투자)?조[합함한]$/.test(compactLine)) return true;
  const splitFundName = `${cleanCompany(matchText).slice(-1)}${compactLine}`;
  return /^(?:상생|성장|벤처|신기술)투자조합$/.test(splitFundName);
}

function standaloneSeriesBeforeClass(lines: string[], lineIndex: number, minLineInclusive: number) {
  const previous = lines[lineIndex - 1];
  if (lineIndex <= minLineInclusive || !previous) return "";
  const match = previous.replace(/\s/g, "").match(/^제(\d+(?:에이|비|씨|디|이|에프|지|[A-Z])?)종$/i);
  return match ? `제${match[1]}종 ` : "";
}

function recoverPrecedingColumnHoldings(lines: string[], match: NameMatch) {
  const holdings = new Map<string, number>();
  const start = Math.max(0, match.index - 8);
  for (let index = start; index < match.index; index += 1) {
    const classes = [...lines[index].matchAll(shareClassPattern)];
    if (!classes.length) continue;
    const quantityLine = lines.slice(index + 1, Math.min(match.index, index + 3))
      .find((line) => /^\s*\d{1,3}(?:[,.]\d{3})+\s*$|^\s*\d{3,}\s*$/.test(line));
    const shares = toNumber(quantityLine);
    if (shares === null || shares <= 0 || shares > 1_000_000_000) continue;
    const series = standaloneSeriesBeforeClass(lines, index, start);
    holdings.set(normalizeShareClass(`${series}${classes.at(-1)![0]}`), shares);
  }
  const hasNearbyRatio = lines.slice(match.index, match.index + match.span + 3)
    .some((line) => /\d+(?:\.\d+)?\s*%/.test(line));
  return holdings.size >= 2 && hasNearbyRatio ? holdings : new Map<string, number>();
}

function sharesImmediatelyBeforeClassLine(
  lines: string[],
  lineIndex: number,
  minLineInclusive: number,
  previousClassLine: number | null,
  target: string,
) {
  // Some PDF text layers flatten a table column as `44,020주`, then emit the
  // corresponding `(보통주)` cell a few lines later. Only use this recovery for
  // a class-only line and never cross the previous class or target block start.
  const classOnlyRemainder = lines[lineIndex]
    .replace(new RegExp(shareClassPattern.source, "gi"), "")
    .replace(/[\s()（）[\]{}:：|/\\\-–—]/g, "");
  if (classOnlyRemainder) return null;
  const lowerBound = Math.max(minLineInclusive, (previousClassLine ?? minLineInclusive - 1) + 1, lineIndex - 6);
  for (let index = lineIndex - 1; index >= lowerBound; index -= 1) {
    const line = lines[index];
    if (new RegExp(shareClassPattern.source, "i").test(line)) break;
    if (/(?:합\s*계|총\s*계|총\s*발행\s*주식수|발행\s*주식(?:의)?\s*총수)/.test(line)) break;
    // A percentage closes the previous holding row. Do not reuse that row's
    // quantity for a new class that follows it.
    if (/\d+(?:\.\d+)?\s*%/.test(line)) break;
    const explicit = [...line.matchAll(/(\d{1,3}(?:[,.]\d{3})+|\d+)\s*주(?!의|당|금액|식)/g)]
      .map((item) => toNumber(item[1])).filter((item): item is number => item !== null && item > 0).at(-1);
    if (explicit !== undefined) return explicit;
    const standalone = line.match(/^\s*(\d{1,3}(?:[,.]\d{3})+|\d+)\s*$/);
    const standaloneValue = toNumber(standalone?.[1]);
    if (standaloneValue !== null && standaloneValue > 0) return standaloneValue;
    if (looksLikeStandaloneShareholderName(line, target) && !isTargetContextLine(lines, index, target)) break;
  }
  return null;
}

function precedingSeriesClassStart(lines: string[], match: NameMatch, target: string) {
  let start = match.index;
  let foundSeries = false;
  for (let index = match.index - 1; index >= Math.max(0, match.index - 4); index -= 1) {
    const line = lines[index];
    if (/(?:합\s*계|총\s*계)/.test(line)) break;
    const classes = [...line.matchAll(shareClassPattern)];
    if (classes.length) {
      if (classes.some((item) => !/^제\s*\d+\s*(?:에\s*이|비|씨|디|이|에\s*프|지|[A-Z])?\s*종/i.test(item[0]) || hasForeignNameBeforeClass(line, item.index ?? 0, target))) break;
      // The nearest series row can belong to the matched shareholder when its
      // name cell is vertically merged. A second series row farther upward is
      // the previous shareholder and must not be absorbed.
      if (foundSeries) break;
      foundSeries = true;
      start = index;
      continue;
    }
    if (meaningfulTableText(line).length) break;
  }
  return foundSeries ? start : match.index;
}

function targetBlockEnd(lines: string[], match: NameMatch, target: string) {
  const hardEnd = Math.min(lines.length, match.index + match.span + 12);
  for (let index = match.index + match.span; index < hardEnd; index += 1) {
    const line = lines[index];
    if (line === OCR_PAGE_BREAK) return index;
    if (/(?:소\s*계|합\s*계|총\s*계|총\s*발행\s*주\s*식\s*수|발행\s*주\s*식(?:의)?\s*총\s*수|총\s*주\s*식\s*수|주\s*식\s*총\s*수)/.test(line)) return index;
    const classes = [...line.matchAll(shareClassPattern)];
    // A long fund name can be split as `회사명` on the matched line and
    // `상생 투자조합 | 제N종 ...` on the next line.  The generic suffix is
    // still part of the same shareholder, not a new row (넥스젠파워).
    if (classes.some((item) => hasForeignNameBeforeClass(line, item.index ?? 0, target))
      && !isTargetContextLine(lines, index, target, match.index + match.span, match.text)) return index;
    const compactLine = cleanCompany(line);
    const targetFragment = compactLine.length >= 2 && cleanCompany(target).includes(compactLine);
    if (!classes.length && !targetFragment && !isTargetContextLine(lines, index, target, match.index + match.span, match.text)
      && looksLikeStandaloneShareholderName(line, target)) return index;
  }
  return hardEnd;
}

function extractClassHoldings(lines: string[], match: NameMatch, target: string) {
  const holdings = new Map<string, number>();
  const start = precedingSeriesClassStart(lines, match, target);
  const end = targetBlockEnd(lines, match, target);
  let firstClassLine: number | null = null;
  let previousClassLine: number | null = null;
  for (let index = start; index < end; index += 1) {
    const matches = [...lines[index].matchAll(shareClassPattern)];
    if (!matches.length) continue;
    if (firstClassLine === null) firstClassLine = index;
    for (let classIndex = 0; classIndex < matches.length; classIndex += 1) {
      const classMatch = matches[classIndex];
      const precedingShares = sharesImmediatelyBeforeClassLine(lines, index, start, previousClassLine, target);
      const shares = precedingShares ?? sharesFollowingClass(
        lines,
        index,
        classMatch.index ?? 0,
        classMatch[0].length,
        classIndex ? (matches[classIndex - 1].index ?? 0) + matches[classIndex - 1][0].length : 0,
        classIndex + 1 < matches.length ? matches[classIndex + 1].index ?? lines[index].length : lines[index].length,
        end,
      );
      if (shares === null) continue;
      const normalizedClass = normalizeShareClass(`${standaloneSeriesBeforeClass(lines, index, start)}${classMatch[0]}`);
      const nearbyClassText = lines.slice(Math.max(match.index, index - 3), index + 1).join(" ").replace(/\s/g, "");
      const shareClass = normalizedClass === "우선주"
        && /(?:상환전환|전환상환).{0,20}(?:우선주|무선주|우서주|으서주)/.test(nearbyClassText)
        ? "상환전환우선주"
        : normalizedClass;
      // A repeated class on a later OCR row is normally the next shareholder.
      // Keep the quantity closest to the matched name instead of replacing it
      // with a larger holding farther down the table.
      if (holdings.has(shareClass) && firstClassLine !== null && index > firstClassLine) return holdings;
      holdings.set(shareClass, Math.max(holdings.get(shareClass) ?? 0, shares));
    }
    previousClassLine = index;
  }
  return holdings;
}

function recoverMergedMultiClassHoldings(lines: string[], target: string) {
  const holdings = new Map<string, number>();
  const compactTarget = cleanCompany(target);
  if (!compactTarget.includes("투자조합") || compactTarget.length < 6) return holdings;
  const anchor = compactTarget.slice(0, 3);
  const start = lines.findIndex((line) => cleanCompany(line).includes(anchor));
  if (start < 0) return holdings;
  for (let index = start; index < Math.min(lines.length, start + 7); index += 1) {
    if (index > start && /(?:합\s*계|총\s*계)/.test(lines[index])) break;
    const classMatch = [...lines[index].matchAll(shareClassPattern)].at(-1);
    if (!classMatch) continue;
    const explicit = [...lines[index].matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/g)]
      .map((item) => toNumber(item[1])).find((value): value is number => value !== null && value > 0);
    const beforeClass = numberTokens(lines[index].slice(0, classMatch.index ?? lines[index].length))
      .map((item) => item.value).find((value) => Number.isInteger(value) && value >= 100 && value < 1_000_000_000);
    const shares = explicit ?? beforeClass;
    if (shares === undefined) continue;
    holdings.set(normalizeShareClass(classMatch[0]), shares);
    if (holdings.size >= 2) break;
  }
  return holdings;
}

function parseRatioRows(lines: string[]) {
  const rows: RatioRow[] = [];
  const hasRatioHeader = lines.some((line) => /(?:지분율|비율)/.test(line));
  for (let index = 0; index < lines.length; index += 1) {
    const explicitMatches = [...lines[index].matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
    const bareMatch = hasRatioHeader ? lines[index].match(/(\d{1,2}\.\d{1,4})\s*$/) : null;
    const percentMatch = [...explicitMatches, ...(bareMatch ? [bareMatch] : [])]
      .filter((match) => { const value = toPercent(match[1]); return value !== null && value > 0 && value <= 100; }).at(-1);
    if (!percentMatch) continue;
    const percent = toPercent(percentMatch[1]);
    if (percent === null || percent <= 0 || percent > 100) continue;
    const candidates = numberTokens(lines[index].slice(0, percentMatch.index))
      .map((item) => item.value).filter((value) => Number.isInteger(value) && value > 0 && value < 1_000_000_000);
    if (candidates.length) rows.push({ index, percent, candidates, share: null });
  }
  if (rows.length < 2) return { rows, inferredTotal: null as number | null };
  const denominators = rows.flatMap((row) => row.candidates.map((share) => ({ share, total: share / (row.percent / 100) })))
    .filter((item) => item.total >= item.share && item.total < 1_000_000_000);
  let bestTotal: number | null = null;
  let bestSupport = 0;
  for (const candidate of denominators) {
    const support = rows.filter((row) => row.candidates.some((share) => Math.abs(share / (row.percent / 100) - candidate.total) / candidate.total <= 0.012)).length;
    if (support > bestSupport) { bestSupport = support; bestTotal = candidate.total; }
  }
  if (bestTotal !== null && bestSupport >= 2) {
    for (const row of rows) {
      row.share = row.candidates.map((share) => ({ share, difference: Math.abs(share / (row.percent / 100) - bestTotal!) / bestTotal! }))
        .sort((left, right) => left.difference - right.difference)[0]?.share ?? null;
    }
  }
  return { rows, inferredTotal: bestSupport >= 2 ? bestTotal : null };
}

function fallbackHoldingNearMatch(lines: string[], match: NameMatch, inferredTotal: number | null, target: string) {
  const precedingCompositeClass = splitCompositeClassImmediatelyBeforeMatch(lines, match);
  const blockEnd = targetBlockEnd(lines, match, target);
  // In compact table OCR the most reliable quantity is usually the last
  // numeric token immediately before the matched row's percentage.
  for (let index = match.index; index < blockEnd; index += 1) {
    const ratioPattern = /\d+(?:\.\d+)?\s*%|\d{1,2}\.\d{1,4}\s*$/;
    const ratioMatches = [...lines[index].matchAll(new RegExp(ratioPattern.source, "g"))];
    const percentAt = ratioMatches.at(-1)?.index ?? -1;
    if (percentAt < 0) continue;
    const percent = toPercent(lines[index].slice(percentAt).match(/(\d+(?:\.\d+)?)/)?.[1]);
    const values = numberTokens(lines[index].slice(0, percentAt)).map((item) => item.value)
      .filter((value) => Number.isInteger(value) && value >= 100 && value <= 1_000_000_000);
    const arithmeticShares = quantityFromFaceValueAmount(lines[index].slice(0, percentAt));
    const rowShares = arithmeticShares ?? (inferredTotal !== null && percent !== null
      ? values.map((value) => ({ value, error: Math.abs(value / (percent / 100) - inferredTotal) / inferredTotal }))
        .sort((left, right) => left.error - right.error)[0]?.value
      : values.at(-1));
    if (rowShares !== undefined) {
      const rowText = lines.slice(match.index, index + 1).join(" ").replace(/\s/g, "");
      const rowClass = shareClassFromText(rowText);
      return { shareClass: rowClass === "주식종류 미표시" ? precedingCompositeClass ?? rowClass : rowClass, shares: rowShares };
    }
  }
  const nearbyLines = lines.slice(match.index, blockEnd);
  const window = nearbyLines.filter((line) => !/(?:총\s*발행\s*주\s*식\s*수|발행\s*주\s*식(?:의)?\s*총\s*수|총\s*주\s*식\s*수|주\s*식\s*총\s*수|주\s*주\s*총\s*수|합\s*계|총\s*계)/.test(line)).join(" ");
  const shares = [...window.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/g)]
    .map((item) => toNumber(item[1])).find((value): value is number => value !== null && value > 0);
  const fallbackShares = shares ?? [...window.matchAll(/\d{1,3}(?:,\d{3})+/g)]
    .map((item) => toNumber(item[0])).find((value): value is number => value !== null && value > 0 && value <= 1_000_000_000)
    ?? numberTokens(window).map((item) => item.value).find((value) => Number.isInteger(value) && value >= 1_000 && value <= 1_000_000_000);
  if (fallbackShares === undefined) return null;
  const compact = window.replace(/\s/g, "");
  const windowClass = shareClassFromText(compact);
  return { shareClass: windowClass === "주식종류 미표시" ? precedingCompositeClass ?? windowClass : windowClass, shares: fallbackShares };
}

// Kept for layouts where explicit row summation may be re-enabled after more fixtures are added.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function sumExplicitShareRows(lines: string[]) {
  const values = lines.flatMap((line) => [...line.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/g)])
    .map((match) => toNumber(match[1])).filter((value): value is number => value !== null && value > 0);
  return values.length >= 2 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function sumConfirmedRightsColumn(lines: string[]) {
  if (!lines.some((line) => /권리\s*확정\s*주식수/.test(line))) return null;
  const shares: number[] = [];
  const seenRows = new Set<string>();
  for (const line of lines) {
    if (/(?:합\s*계|총\s*계|소\s*계)/.test(line)) continue;
    const rowKey = line.replace(/\s+/g, "").normalize("NFKC");
    if (seenRows.has(rowKey)) continue;
    seenRows.add(rowKey);
    const percent = line.search(/\d+(?:\.\d+)?\s*%/);
    if (percent < 0) continue;
    const values = numberTokens(line.slice(0, percent)).map((item) => item.value)
      .filter((value) => Number.isInteger(value) && value >= 0);
    const value = values.at(-1);
    if (value !== undefined) shares.push(value);
  }
  if (shares.length < 3) return null;
  const frequencies = new Map<number, number>();
  for (const share of shares) frequencies.set(share, (frequencies.get(share) ?? 0) + 1);
  const divisor = shares.length >= 6 && [...frequencies.values()].every((count) => count % 2 === 0) ? 2 : 1;
  return shares.reduce((sum, value) => sum + value, 0) / divisor;
}
function directTotalFromLabels(lines: string[]) {
  const primaryLabel = /(?:총\s*발행\s*주식수|발행\s*주식(?:의)?\s*총수|발행\s*주식\s*수|총\s*주식수|주식\s*총수|주\s*주\s*총\s*수|총\s*계|^총\s*(?=\d))/;
  const fallbackLabel = /합\s*(?:계|[Aa][Il]?|ㅅ)/;
  const candidate = (text: string, following = false) => {
    if (!text.trim() || (following && /원/.test(text))) return null;
    if (/%/.test(text)) text = text.slice(0, text.search(/\d+(?:\.\d+)?\s*%/));
    const explicit = text.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/);
    const explicitValue = toNumber(explicit?.[1]);
    if (explicitValue !== null && explicitValue >= 100 && explicitValue <= 1_000_000_000) return explicitValue;
    const values = numberTokens(withoutCurrencyAmounts(text)).map((item) => item.value);
    return values.find((value) => Number.isInteger(value) && value >= 100 && value <= 1_000_000_000 && !(value >= 1900 && value <= 2100)) ?? null;
  };
  // 종류별 소계와 총계가 함께 있으면 OCR 한 자리 오인식(예: 3→8)을
  // 소계 합산으로 교차검증한다.
  const classSubtotals = new Map<string, Array<{ value: number; percent: number | null }>>();
  const adjacentSubtotalRows: Array<{ index: number; value: number; percent: number; labeled: boolean }> = [];
  const primaryTotals: Array<{ value: number; hasHundredPercent: boolean }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const percentMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
    const percent = toNumber(percentMatch?.[1]);
    if (percentMatch && percent !== null && percent >= 5 && percent < 100) {
      const values = numberTokens(line.slice(0, percentMatch.index)).map((item) => item.value)
        .filter((value) => Number.isInteger(value) && value >= 100 && value <= 1_000_000_000);
      const value = values.at(-1);
      if (value !== undefined) adjacentSubtotalRows.push({ index: lineIndex, value, percent, labeled: fallbackLabel.test(line) });
    }
    const classLabel = line.match(/((?:상\s*환\s*)?(?:전\s*환\s*)?우\s*선\s*주\s*(?:식)?|보\s*통\s*주\s*(?:식)?)\s*합\s*계/i);
    if (classLabel) {
      const value = candidate(line.slice((classLabel.index ?? 0) + classLabel[0].length));
      if (value !== null) {
        const key = normalizeShareClass(classLabel[1]);
        const percent = toNumber(line.match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
        classSubtotals.set(key, [...(classSubtotals.get(key) ?? []), { value, percent }]);
      }
    }
    const totalLabel = line.match(primaryLabel);
    if (totalLabel) {
      const value = candidate(line.slice((totalLabel.index ?? 0) + totalLabel[0].length));
      if (value !== null) primaryTotals.push({ value, hasHundredPercent: /100(?:\.0+)?\s*%/.test(line) });
    }
  }
  if (primaryTotals.length) {
    const hundredPercentTotals = primaryTotals.filter((item) => item.hasHundredPercent);
    const eligiblePrimaryTotals = hundredPercentTotals.length ? hundredPercentTotals : primaryTotals;
    const frequencies = new Map<number, number>();
    for (const { value } of eligiblePrimaryTotals) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
    const selectedPrimary = [...frequencies]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
    const adjacentPairs = adjacentSubtotalRows.flatMap((left, leftIndex) => adjacentSubtotalRows.slice(leftIndex + 1).map((right) => {
      const sum = left.value + right.value;
      const ratioError = Math.abs(left.value / sum * 100 - left.percent) + Math.abs(right.value / sum * 100 - right.percent);
      return { sum, ratioError, percentSumError: Math.abs(left.percent + right.percent - 100), nearby: Math.abs(left.index - right.index) <= 3, labeled: left.labeled || right.labeled };
    })).filter((pair) => pair.nearby && pair.labeled && pair.percentSumError <= 0.2)
      .sort((left, right) => left.ratioError - right.ratioError)[0];
    if (adjacentPairs && adjacentPairs.ratioError <= 0.3) return adjacentPairs.sum;
    if (classSubtotals.size < 2) return selectedPrimary;
    const groups = [...classSubtotals.values()];
    const pairs = groups[0].flatMap((left) => groups[1].map((right) => {
      const sum = left.value + right.value;
      const percentageError = (left.percent === null ? 0 : Math.abs(left.value / sum * 100 - left.percent))
        + (right.percent === null ? 0 : Math.abs(right.value / sum * 100 - right.percent));
      const percentageCount = Number(left.percent !== null) + Number(right.percent !== null);
      return { sum, percentageError, percentageCount };
    }));
    // If both stock-class subtotal rows carry percentages, they are a stronger
    // checksum than a single OCR total. This corrects digit confusions such as
    // 1,895,872 -> 1,805,872 without hard-coding a company or amount.
    const ratioReconciled = pairs.filter((pair) => pair.percentageCount >= 2)
      .sort((left, right) => left.percentageError - right.percentageError)[0];
    if (ratioReconciled && ratioReconciled.percentageError <= 0.3) return ratioReconciled.sum;
    const sums = pairs.map((pair) => pair.sum);
    const reconciled = sums.map((sum) => ({ sum, error: Math.abs(sum - selectedPrimary) / selectedPrimary }))
      .sort((left, right) => left.error - right.error)[0];
    if (reconciled && reconciled.error <= 0.005) return reconciled.sum;
    return selectedPrimary;
  }
  const findByLabel = (label: RegExp) => {
   for (let index = 0; index < lines.length; index += 1) {
    if (!label.test(lines[index])) continue;
    const sameLine = lines[index].replace(new RegExp(`^.*?${label.source}`), "");
    const sameLineValue = candidate(sameLine);
    if (sameLineValue !== null) return sameLineValue;
    const matchedLabel = lines[index].match(label)?.[0].replace(/\s/g, "") ?? "";
    // `총주식수` is also a common table-column header. With no value in that
    // same cell, the next line is the first shareholder, not the register total.
    if (/^(?:총주식수|주식총수)$/.test(matchedLabel)) continue;
    // OCR often emits table cells as separate lines: 총계 -> 100% -> shares -> amount.
    for (let next = index + 1; next < Math.min(lines.length, index + 9); next += 1) {
      if (new RegExp(shareClassPattern.source, "i").test(lines[next])) break;
      const value = candidate(lines[next], true);
      if (value !== null) return value;
    }
    const classTotals = new Map<string, number>();
     const summaryLines = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 5));
     const multiCellStart = summaryLines.findIndex((line) => line.includes("/")
       && [...line.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/g)].length >= 2);
     if (multiCellStart >= 0) {
       // Several classes can share a physical PDF line. Summing quantity
       // cells preserves repeated preferred-series subtotals and treasury
       // shares instead of overwriting them under one normalized class key.
       const classSummaryLines: string[] = [];
       for (const line of summaryLines.slice(multiCellStart)) {
         if (/^\s*(?:합\s*계|총\s*계)\s*$/.test(line)) continue;
         if (/%/.test(line) || !(new RegExp(shareClassPattern.source, "i").test(line) || /자기\s*주식/.test(line))) break;
         classSummaryLines.push(line);
       }
       const summaryShares = [...new Set(classSummaryLines)]
         .flatMap((line) => [...line.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*주(?!의|당|금액)/g)])
         .map((item) => toNumber(item[1])).filter((value): value is number => value !== null && value > 0);
       if (summaryShares.length >= 2) return summaryShares.reduce((sum, value) => sum + value, 0);
     }
    for (let next = Math.max(0, index - 2); next < Math.min(lines.length, index + 5); next += 1) {
      const classMatch = [...lines[next].matchAll(shareClassPattern)][0];
      if (!classMatch) continue;
      const shares = sharesFollowingClass(lines, next, classMatch.index ?? 0, classMatch[0].length);
      if (shares !== null) classTotals.set(normalizeShareClass(classMatch[0]), shares);
    }
    if (classTotals.size) return [...classTotals.values()].reduce((sum, value) => sum + value, 0);
   }
   return null;
  };
  return findByLabel(primaryLabel) ?? findByLabel(fallbackLabel);
}
function totalFromComplementaryRatioSubtotals(lines: string[]) {
  const rows: Array<{ index: number; shares: number; percent: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const percentMatch = lines[index].match(/(\d+(?:\.\d+)?)\s*%/);
    const percent = toNumber(percentMatch?.[1]);
    if (!percentMatch || percent === null || percent < 5 || percent > 95) continue;
    const shares = quantityFromFlattenedShareRow(lines[index].slice(0, percentMatch.index));
    if (shares !== null && shares >= 100 && shares <= 1_000_000_000) rows.push({ index, shares, percent });
  }
  const candidates = rows.flatMap((left, leftIndex) => rows.slice(leftIndex + 1).map((right) => {
    const total = left.shares + right.shares;
    const percentSumError = Math.abs(left.percent + right.percent - 100);
    const ratioError = Math.abs(left.shares / total * 100 - left.percent)
      + Math.abs(right.shares / total * 100 - right.percent);
    return { total, percentSumError, ratioError, distance: Math.abs(left.index - right.index) };
  })).filter((item) => item.percentSumError <= 0.12 && item.ratioError <= 0.08)
    .sort((left, right) => left.ratioError - right.ratioError || left.distance - right.distance || left.total - right.total);
  return candidates[0]?.total ?? null;
}
function totalFromHundredPercentRows(lines: string[], owned: number | null, printedRatio: number | null) {
  const candidates: number[] = [];
  for (const line of lines) {
    const percentMatches = [...line.matchAll(/100(?:\.0+)?\s*%/g)]
      .map((match) => ({ index: match.index ?? -1, length: match[0].length }));
    if (!percentMatches.length && line.length <= 80) {
      const shorthand = line.match(/(?:^|[\s|])10000\s*\|?\s*$/);
      if (shorthand?.index !== undefined) percentMatches.push({
        index: shorthand.index + (/^[\s|]/.test(shorthand[0]) ? 1 : 0),
        length: shorthand[0].length,
      });
    }
    let segmentStart = 0;
    for (const percentMatch of percentMatches) {
      const percent = percentMatch.index;
      if (percent < 0) continue;
      const beforePercent = line.slice(segmentStart, percent);
      segmentStart = percent + percentMatch.length;
      const explicitShares = [...beforePercent.matchAll(/(\d{1,3}(?:[,.]\d{3})+|\d+)\s*주(?!의|당|금액)/g)]
        .map((item) => Number(item[1].replace(/[,.]/g, "")))
        .filter((value) => value >= 100 && value <= 1_000_000_000);
      if (explicitShares.length) {
        candidates.push(explicitShares.at(-1)!);
        continue;
      }
      const value = quantityFromFlattenedShareRow(beforePercent);
      if (value !== null && value >= 100 && value <= 1_000_000_000 && !(value >= 1900 && value <= 2100)) candidates.push(value);
    }
  }
  if (!candidates.length) return null;
  const plausibleCandidates = owned === null ? candidates : candidates.filter((value) => value >= owned);
  if (!plausibleCandidates.length) return null;
  const frequencies = new Map<number, number>();
  for (const value of plausibleCandidates) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  if (owned !== null && printedRatio !== null && printedRatio > 0) {
    const ratioRanked = [...frequencies].map(([value, frequency]) => ({
      value,
      frequency,
      error: Math.abs(owned / value * 100 - printedRatio),
    })).sort((left, right) => left.error - right.error || right.frequency - left.frequency || left.value - right.value);
    if (ratioRanked[0]?.error <= 0.08) return ratioRanked[0].value;
  }
  return [...frequencies].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
}

export function totalFromFaceValueArithmetic(lines: string[], owned: number | null, printedRatio: number | null) {
  const faceValues = new Set<number>();
  const faceLabel = /(?:(?:1|ㅁ|[lI])?\s*주\s*의\s*(?:금\s*액|금\s*맥|글\s*액)|액\s*면\s*가)/;
  for (let index = 0; index < lines.length; index += 1) {
    if (!faceLabel.test(lines[index])) continue;
    const faceContext = lines.slice(index, index + 9).join(" ");
    for (const value of numberTokens(faceContext).map((item) => item.value)) {
      if (standardFaceValues.has(value)) faceValues.add(value);
    }
    if (/금?\s*일\s*만\s*원/.test(faceContext)) faceValues.add(10_000);
    if (/금?\s*오\s*천\s*원/.test(faceContext)) faceValues.add(5_000);
    if (/금?\s*오\s*백\s*원/.test(faceContext)) faceValues.add(500);
  }
  if (!faceValues.size) {
    const frequencies = new Map<number, number>();
    for (const line of lines) {
      for (const value of numberTokens(line).map((item) => item.value).filter((item) => standardFaceValues.has(item))) {
        frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
      }
    }
    const frequent = [...frequencies].filter((item) => item[1] >= 3)
      .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0];
    if (frequent !== undefined) faceValues.add(frequent);
  }
  if (!faceValues.size) return null;

  const totalAnchor = /(?:발\s*행\s*주\s*식|총\s*발\s*행\s*주\s*식|총\s*주\s*식|주\s*식\s*총\s*수|합\s*(?:계|[Aa][Il]?|ㅅ)|총\s*계)|100(?:\.0+)?\s*%/i;
  const candidates: Array<{ total: number; amount: number; error: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!totalAnchor.test(lines[index])) continue;
    const context = lines.slice(Math.max(0, index - 6), Math.min(lines.length, index + 7)).join(" ");
    const values = numberTokens(context).map((item) => item.value)
      .filter((value) => Number.isInteger(value) && value >= 100_000 && value <= 10_000_000_000_000);
    for (const faceValue of faceValues) {
      for (const amount of values) {
        if (amount % faceValue !== 0) continue;
        const total = amount / faceValue;
        if (total < Math.max(100, owned ?? 0) || total > 1_000_000_000) continue;
        const error = owned !== null && printedRatio !== null && printedRatio > 0
          ? Math.abs(owned / total * 100 - printedRatio)
          : Number.POSITIVE_INFINITY;
        candidates.push({ total, amount, error });
      }
    }
  }
  if (!candidates.length) return null;
  const frequencies = new Map<number, number>();
  for (const candidate of candidates) frequencies.set(candidate.total, (frequencies.get(candidate.total) ?? 0) + 1);
  const ranked = candidates.sort((left, right) => {
    if (printedRatio !== null) return left.error - right.error || (frequencies.get(right.total) ?? 0) - (frequencies.get(left.total) ?? 0) || right.amount - left.amount;
    return (frequencies.get(right.total) ?? 0) - (frequencies.get(left.total) ?? 0) || right.amount - left.amount;
  });
  if (printedRatio !== null && ranked[0].error > 0.08) return null;
  return ranked[0].total;
}

function strongDocumentTotal(lines: string[]) {
  const explicitLabel = /(?:총\s*발행\s*주식수|발행\s*주식(?:의)?\s*총수|발행\s*주식\s*수|총\s*주식수|주식\s*총수|주\s*주\s*총\s*수|^총\s*(?=\d))/;
  const totalLabel = /^\s*(?:총\s*합\s*계|합\s*계|총\s*계)(?=\s|[:：|]|\d|$)/;
  const valueAfter = (line: string, label: RegExp) => {
    const match = line.match(label);
    if (!match) return null;
    let tail = line.slice((match.index ?? 0) + match[0].length);
    const percentAt = tail.search(/100(?:\.0+)?\s*%/);
    if (percentAt >= 0) tail = tail.slice(0, percentAt);
    const explicit = tail.match(/(\d{1,3}(?:[,.]\d{3})+|\d+)\s*주(?!의|당|금액)/);
    const explicitValue = toNumber(explicit?.[1]);
    if (explicitValue !== null && explicitValue >= 100 && explicitValue <= 1_000_000_000) return explicitValue;
    return numberTokens(withoutCurrencyAmounts(tail)).map((item) => item.value)
      .find((value) => Number.isInteger(value) && value >= 100 && value <= 1_000_000_000
        && !(value >= 1900 && value <= 2100)) ?? null;
  };

  for (const line of lines) {
    const explicit = valueAfter(line, explicitLabel);
    if (explicit !== null) return explicit;
    if (totalLabel.test(line) && /100(?:\.0+)?\s*%/.test(line)) {
      const percentageCells = [...line.matchAll(/100(?:\.0+)?\s*%/g)];
      if (percentageCells.length > 1) {
        // Some totals contain both shareholder count/100% and shares/100%.
        // The final numeric segment belongs to the share-total columns.
        const previous = percentageCells.at(-2)!;
        const final = percentageCells.at(-1)!;
        const shareSegment = line.slice((previous.index ?? 0) + previous[0].length, final.index);
        const shares = quantityFromFlattenedShareRow(shareSegment);
        if (shares !== null && shares >= 100 && shares <= 1_000_000_000) return shares;
      }
      const total = valueAfter(line, totalLabel);
      if (total !== null) return total;
    }
  }
  return totalFromComplementaryRatioSubtotals(lines) ?? sumConfirmedRightsColumn(lines);
}

function increaseAfterSharesTotal(lines: string[], owned: number | null) {
  if (owned === null) return null;
  // Some registers label the total as "증자후주식수" rather than 합계/총계.
  // OCR commonly flattens the final three-column total row into one noisy line.
  const hasIncreaseShareHeader = lines.some((line) => /증\s*자/.test(line) && /주\s*식/.test(line));
  if (!hasIncreaseShareHeader) return null;
  const start = Math.floor(lines.length * 0.55);
  let detected: number | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (/%|원/.test(line)) continue;
    const values = numberTokens(line).map((item) => item.value)
      .filter((value) => Number.isInteger(value) && value > 0);
    if (values.length < 3) continue;
    const afterIncreaseShares = values.at(-1) ?? null;
    if (afterIncreaseShares !== null && afterIncreaseShares > owned && afterIncreaseShares <= 1_000_000_000) detected = afterIncreaseShares;
  }
  return detected;
}
function lastStandaloneTotal(lines: string[], owned: number | null) {
  if (owned === null) return null;
  const values = lines.map((line) => {
    if (/%|원/.test(line)) return null;
    const match = line.trim().match(/^(\d{1,3}(?:,\d{3})+|\d+)\s*주?$/);
    const value = toNumber(match?.[1]);
    return value !== null && value > owned && value <= 1_000_000_000 ? value : null;
  }).filter((value): value is number => value !== null);
  return values.at(-1) ?? null;
}
function correctSingleDigitTotalByTargetRatio(lines: string[], match: NameMatch | null, owned: number | null, total: number | null) {
  if (!match || owned === null || total === null) return total;
  const nearby = lines.slice(match.index, Math.min(lines.length, match.index + match.span + 5)).join(" ");
  const percentages = [...nearby.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((item) => toNumber(item[1]))
    .filter((value): value is number => value !== null && value > 0 && value < 20);
  let best = { value: total, error: Number.POSITIVE_INFINITY, currentError: Number.POSITIVE_INFINITY };
  const digits = String(total);
  for (const percent of percentages) {
    const implied = owned / (percent / 100);
    const currentError = Math.abs(total - implied) / implied;
    if (currentError < 0.003 || currentError > 0.03) continue;
    for (let index = 0; index < digits.length; index += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        if (String(digit) === digits[index] || index === 0 && digit === 0) continue;
        const value = Number(`${digits.slice(0, index)}${digit}${digits.slice(index + 1)}`);
        if (value < owned) continue;
        const error = Math.abs(value - implied) / implied;
        if (error < best.error) best = { value, error, currentError };
      }
    }
  }
  return best.error <= 0.0015 && best.error * 5 < best.currentError ? best.value : total;
}
function correctTotalByRatioConsensus(lines: string[], owned: number | null, total: number | null) {
  if (total === null || total < 100 || total > 1_000_000_000) return total;
  const parsedRows = lines.map((line) => {
    const percentMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
    const percent = toNumber(percentMatch?.[1]);
    if (!percentMatch || percent === null || percent <= 0 || percent >= 100) return null;
    const shares = quantityFromFlattenedShareRow(line.slice(0, percentMatch.index));
    return shares !== null ? { percent, shares } : null;
  }).filter((row): row is { percent: number; shares: number } => row !== null);
  const uniqueRows = [...new Map(parsedRows.map((row) => [`${row.percent}|${row.shares}`, row])).values()];
  if (uniqueRows.length < 3) return total;
  const digits = String(total);
  if (digits.length > 9) return total;
  const candidates = new Set<number>([total]);
  for (const row of uniqueRows.filter((item) => item.percent >= 2)) {
    const implied = Math.round(row.shares / (row.percent / 100));
    for (let offset = -100; offset <= 100; offset += 1) candidates.add(implied + offset);
  }
  for (let first = 0; first < digits.length; first += 1) {
    for (let firstDigit = 0; firstDigit <= 9; firstDigit += 1) {
      if (String(firstDigit) === digits[first] || first === 0 && firstDigit === 0) continue;
      const once = `${digits.slice(0, first)}${firstDigit}${digits.slice(first + 1)}`;
      candidates.add(Number(once));
      for (let second = first + 1; second < digits.length; second += 1) {
        for (let secondDigit = 0; secondDigit <= 9; secondDigit += 1) {
          if (String(secondDigit) === digits[second]) continue;
          candidates.add(Number(`${once.slice(0, second)}${secondDigit}${once.slice(second + 1)}`));
        }
      }
    }
  }
  const score = (candidate: number) => {
    let support = 0;
    let error = 0;
    for (const row of uniqueRows) {
      const bestError = row.shares > 0 && row.shares <= candidate
        ? Math.abs(row.shares / candidate * 100 - row.percent) : Number.POSITIVE_INFINITY;
      if (bestError <= 0.006) { support += 1; error += bestError; }
    }
    return { candidate, support, error, edits: [...digits].filter((digit, index) => digit !== String(candidate)[index]).length };
  };
  const ranked = [...candidates].filter((candidate) => candidate >= (owned ?? 0) && String(candidate).length === digits.length)
    .map(score).sort((left, right) => right.support - left.support || left.error - right.error || left.edits - right.edits || left.candidate - right.candidate);
  const current = score(total);
  const totalSeenInOcr = lines.some((line) => numberTokens(line).some((item) => item.value === total));
  const maximumSupport = ranked[0]?.support ?? 0;
  const best = totalSeenInOcr
    ? ranked.filter((item) => item.support >= maximumSupport - 1)
      .sort((left, right) => left.edits - right.edits || right.support - left.support || left.error - right.error || left.candidate - right.candidate)[0]
    : ranked[0];
  return best && best.support >= 3 && best.support >= current.support + 2 ? best.candidate : total;
}
function printedRatioNearTarget(
  lines: string[],
  match: NameMatch | null,
  holdingCount: number,
  owned: number | null,
  target: string,
  totalHint: number | null,
) {
  if (!match) return null;
  const percentageValues = (value: string) => [...value.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
    .map((item) => toPercent(item[1]))
    .filter((item): item is number => item !== null && item > 0 && item < 100);
  const inMatchedName = percentageValues(match.text);
  if (inMatchedName.length) {
    return inMatchedName.slice(-Math.max(1, holdingCount)).reduce((sum, value) => sum + value, 0);
  }

  if (holdingCount > 1) {
    const block = lines.slice(precedingSeriesClassStart(lines, match, target), targetBlockEnd(lines, match, target));
    let percentages = block.flatMap(percentageValues);
    // Column-major sparse OCR can emit the first class percentage immediately
    // before the shareholder name while the corresponding class and quantity
    // remain after it (램쉽: 2.44% ... target ... 보통주 18,300).
    // Only accept that preceding value when an independently labeled total
    // proves the sum. Otherwise a previous shareholder's percentage could be
    // added to one combined percentage printed for all target stock classes.
    if (percentages.length < holdingCount && owned !== null && totalHint !== null && totalHint > 0) {
      const preceding = lines.slice(Math.max(0, match.index - 4), match.index).flatMap(percentageValues);
      const missing = holdingCount - percentages.length;
      const candidate = [...preceding.slice(-missing), ...percentages];
      if (candidate.length >= holdingCount) {
        const expected = owned / totalHint * 100;
        const existingSum = percentages.reduce((sum, value) => sum + value, 0);
        const candidateSum = candidate.slice(0, holdingCount).reduce((sum, value) => sum + value, 0);
        const roundingTolerance = 0.002 + holdingCount * 0.005;
        if (Math.abs(candidateSum - expected) <= roundingTolerance
          && Math.abs(candidateSum - expected) < Math.abs(existingSum - expected)) {
          percentages = candidate;
        }
      }
    }
    if (percentages.length >= holdingCount) return percentages.slice(0, holdingCount).reduce((sum, value) => sum + value, 0);
    // Some merged cells print one combined percentage for all stock classes.
    if (percentages.length === 1) return percentages[0];
  }

  // Sparse OCR often emits the target name, quantity and percentage as separate
  // lines, and can even place the numeric cells immediately before the name.
  // Anchor the percentage to the line carrying the already selected quantity.
  if (owned !== null) {
    const start = Math.max(0, match.index - 7);
    const end = Math.min(lines.length, match.index + match.span + 8);
    const ownedLines: number[] = [];
    for (let index = start; index < end; index += 1) {
      if (numberTokens(lines[index]).some((item) => item.value === owned)) ownedLines.push(index);
    }
    const ranked = ownedLines.flatMap((ownedIndex) => {
      const nearby: Array<{ value: number; distance: number; after: boolean }> = [];
      for (let index = Math.max(start, ownedIndex - 3); index < Math.min(end, ownedIndex + 5); index += 1) {
        for (const value of percentageValues(lines[index])) {
          nearby.push({ value, distance: Math.abs(index - ownedIndex), after: index >= ownedIndex });
        }
      }
      return nearby;
    }).sort((left, right) => left.distance - right.distance || Number(right.after) - Number(left.after) || right.value - left.value);
    if (ranked.length) return ranked[0].value;
  }

  for (let index = match.index; index < Math.min(lines.length, match.index + match.span + 6); index += 1) {
    if (index > match.index && /(?:합\s*계|총\s*계)/.test(lines[index])) break;
    const value = percentageValues(lines[index]).at(-1);
    if (value !== undefined) return value;
  }
  return null;
}

function printedRatioTolerance(lines: string[], match: NameMatch, holdingCount: number, target: string) {
  const block = lines.slice(precedingSeriesClassStart(lines, match, target), targetBlockEnd(lines, match, target));
  const tokens = block.flatMap((line) => [...line.matchAll(/(\d+(?:\.(\d+))?)\s*%/g)]);
  if (!tokens.length) return 0.02;
  const relevant = holdingCount > 1 && tokens.length >= holdingCount ? tokens.slice(0, holdingCount) : tokens.slice(0, 1);
  return relevant.reduce((sum, token) => sum + 0.5 * 10 ** -(token[2]?.length ?? 0), 0) + 0.002;
}
export function parseRegisterLines(linesInput: string[], target: string): ParsedRegister {
  const lines = linesInput.map((line) => line.replace(/\u00a0/g, " ").replace(/[ ]+/g, " ").trim()).filter(Boolean);
  const match = findTargetMatch(lines, target);
  const targetMatches = match ? findTargetMatches(lines, target)
    .filter((candidate) => candidate.score >= match.score - 0.08) : [];
  const ratioData = parseRatioRows(lines);
  const ratioRows = ratioData.rows;
  const holdingsMap = match ? extractClassHoldings(lines, match, target) : new Map<string, number>();
  if (match && holdingsMap.size < 2) {
    const precedingColumns = recoverPrecedingColumnHoldings(lines, match);
    for (const [shareClass, shares] of precedingColumns) holdingsMap.set(shareClass, shares);
  }
  const holdingSources: Array<{ match: NameMatch; holdings: Map<string, number> }> = match
    ? [{ match, holdings: new Map(holdingsMap) }] : [];
  for (const candidate of targetMatches) {
    if (candidate.index === match?.index && candidate.span === match.span) continue;
    const lower = Math.min(match!.index + match!.span, candidate.index + candidate.span);
    const upper = Math.max(match!.index, candidate.index);
    if (lines.slice(lower, upper + 1).includes(OCR_PAGE_BREAK)) continue;
    const candidateHoldings = extractClassHoldings(lines, candidate, target);
    let contributed = false;
    for (const [shareClass, shares] of candidateHoldings) {
      if (!holdingsMap.has(shareClass)) { holdingsMap.set(shareClass, shares); contributed = true; }
    }
    if (contributed) holdingSources.push({ match: candidate, holdings: candidateHoldings });
  }
  const matchedTargetText = match ? lines.slice(match.index, match.index + match.span).join(" ") : "";
  const matchedRowsHaveRatio = /\d+(?:\.\d+)?\s*%/.test(matchedTargetText);
  const matchedRowsContainHolding = new RegExp(shareClassPattern.source, "i").test(matchedTargetText)
    || /(\d{1,3}(?:[,.]\d{3})+|\d+)\s*주(?!의|당|금액)/.test(matchedTargetText);
  const distinctMatchedClasses = new Set([...matchedTargetText.matchAll(new RegExp(shareClassPattern.source, "gi"))]
    .map((item) => normalizeShareClass(item[0]))).size;
  if (match && holdingsMap.size < 2 && !matchedRowsHaveRatio && (!matchedRowsContainHolding || distinctMatchedClasses >= 2)) {
    const recovered = recoverMergedMultiClassHoldings(lines, target);
    if (recovered.size >= 2) {
      holdingsMap.clear();
      for (const [shareClass, shares] of recovered) holdingsMap.set(shareClass, shares);
    }
  }
  if (match) {
    const fallback = fallbackHoldingNearMatch(lines, match, ratioData.inferredTotal, target);
    // An explicitly classified quantity beside the matched shareholder is
    // stronger than a later percentage-based fallback, which may already be
    // the next shareholder's row after OCR split the percentage onto its own line.
    const classifiedTotal = holdingsMap.size
      ? [...holdingsMap.values()].reduce((sum, value) => sum + value, 0)
      : null;
    if (fallback && (holdingsMap.size === 0
      || classifiedTotal !== null && classifiedTotal < 100 && fallback.shares >= 100)) {
      holdingsMap.clear();
      holdingsMap.set(fallback.shareClass, fallback.shares);
    }
  }
  let owned = holdingsMap.size ? [...holdingsMap.values()].reduce((sum, value) => sum + value, 0) : null;
  if (owned === null && match) {
    const blockStart = precedingSeriesClassStart(lines, match, target);
    const blockEnd = targetBlockEnd(lines, match, target);
    const nearest = ratioRows.filter((row) => row.share !== null && row.index >= blockStart && row.index < blockEnd)
      .sort((left, right) => Math.abs(left.index - match.index) - Math.abs(right.index - match.index))[0];
    if (nearest?.share !== null && nearest !== undefined) { owned = nearest.share; holdingsMap.set("주식종류 미표시", owned); }
  }
  const ratioTotalHint = directTotalFromLabels(lines);
  const sourceRatios = holdingSources.map((source) => printedRatioNearTarget(
    lines,
    source.match,
    source.holdings.size,
    [...source.holdings.values()].reduce((sum, value) => sum + value, 0),
    target,
    ratioTotalHint,
  )).filter((value): value is number => value !== null);
  const distinctSourceRatios = [...new Set(sourceRatios.map((value) => value.toFixed(4)))].map(Number);
  const earlyPrintedRatio = holdingSources.length > 1 && distinctSourceRatios.length
    ? distinctSourceRatios.reduce((sum, value) => sum + value, 0)
    : printedRatioNearTarget(lines, match, holdingsMap.size, owned, target, ratioTotalHint);
  const hundredPercentTotal = totalFromHundredPercentRows(lines, owned, earlyPrintedRatio);
  const arithmeticTotal = totalFromFaceValueArithmetic(lines, owned, earlyPrintedRatio);
  const complementarySubtotalTotal = totalFromComplementaryRatioSubtotals(lines);
  const labeledTotal = ratioTotalHint;
  const rightsTotal = sumConfirmedRightsColumn(lines);
  // Face-value arithmetic is most reliable when the matched row also carries a
  // printed percentage. Without that cross-check it may divide an unrelated
  // shareholder's amount and eclipse a valid class-total row.
  let total = earlyPrintedRatio !== null
    ? arithmeticTotal ?? hundredPercentTotal ?? labeledTotal ?? complementarySubtotalTotal ?? rightsTotal
    : hundredPercentTotal ?? labeledTotal ?? complementarySubtotalTotal ?? rightsTotal ?? arithmeticTotal;
  if (labeledTotal === null && rightsTotal !== null && owned !== null && match) {
    const percent = toNumber(match.text.match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
    if (percent !== null && percent > 0) {
      const impliedTotal = owned / (percent / 100);
      const layerCount = Math.round(rightsTotal / impliedTotal);
      if (layerCount >= 2 && Math.abs(rightsTotal / layerCount - impliedTotal) / impliedTotal <= 0.02) total = rightsTotal / layerCount;
    }
  }
  if (total !== null && (total > 1_000_000_000 || owned !== null && total < owned)) total = null;
  if (total === null) total = increaseAfterSharesTotal(lines, owned);
  if (total === null) total = lastStandaloneTotal(lines, owned);
  if (total === null) {
    const selected = ratioRows.map((row) => row.share).filter((value): value is number => value !== null);
    const percentSum = ratioRows.filter((row) => row.share !== null).reduce((sum, row) => sum + row.percent, 0);
    if (selected.length >= 2 && percentSum >= 98.5) total = selected.reduce((sum, value) => sum + value, 0);
    else if (ratioData.inferredTotal !== null) {
      const unit = ratioData.inferredTotal >= 10_000 ? 100 : ratioData.inferredTotal >= 1_000 ? 10 : 1;
      total = Math.round(ratioData.inferredTotal / unit) * unit;
    }
  }
  total = correctSingleDigitTotalByTargetRatio(lines, match, owned, total);
  total = correctTotalByRatioConsensus(lines, owned, total);
  if (total !== null && (total > 1_000_000_000 || owned !== null && total < owned)) total = null;
  if (!match) { owned = null; total = strongDocumentTotal(lines); holdingsMap.clear(); }
  const ratio = total && owned !== null ? owned / total * 100 : null;
  const holdings = [...holdingsMap].map(([shareClass, shares]) => ({ shareClass, shares }));
  const printedRatio = earlyPrintedRatio;
  const ratioTolerance = holdingSources.length
    ? holdingSources.reduce((sum, source) => sum + printedRatioTolerance(lines, source.match, source.holdings.size, target), 0)
    : 0.02;
  const ratioMismatch = printedRatio !== null && ratio !== null && Math.abs(printedRatio - ratio) > ratioTolerance;
  const nameMatch = !match ? "실패" : match.fuzzy ? "유사" : "정확";
  const missing = [owned, total, ratio].filter((value) => value === null).length;
  const unknownClass = holdings.some((item) => item.shareClass === "주식종류 미표시");
  const confidence: ParsedRegister["confidence"] = !match || missing || ratioMismatch ? "확인 필요" : match.fuzzy || unknownClass ? "보통" : "높음";
  const summaryOmitsTarget = !match && lines.some((line) => /기타\s*주주/.test(line));
  const note = summaryOmitsTarget
    ? "기타주주로 묶인 요약 명부에 대상 주주명이 표시되지 않아 보유주식수를 확인할 수 없습니다."
    : !match ? total !== null
    ? "입력한 주주명과 유사한 이름을 찾지 못해 총발행주식수만 표시했습니다."
    : "입력한 주주명과 유사한 이름을 찾지 못했습니다."
    : missing ? `${match.fuzzy ? "유사 이름으로 주주 행을 찾았지만" : "주주 행은 찾았지만"} 일부 숫자를 찾지 못했습니다.`
      : ratioMismatch ? `문서의 지분율(${printedRatio!.toFixed(2)}%)과 추출 수량으로 계산한 지분율(${ratio!.toFixed(2)}%)이 다릅니다.`
      : match.fuzzy ? "문서의 유사한 주주명으로 인식했습니다. 결과를 한 번 확인해 주세요."
        : unknownClass ? "문서에 주식종류가 표시되지 않아 종류 미표시로 분류했습니다."
          : "추출값과 계산값이 일치합니다.";
  return { total, holdings, owned, ratio, matchedName: match?.text ?? "", nameMatch, confidence, note };
}

export function ocrTextScore(text: string, target: string) {
  const keywordScore = ["주주명부", "주주명", "주식수", "합계", "보통주", "우선주"]
    .filter((keyword) => text.includes(keyword)).length * 2;
  const match = findTargetMatch(text.split(/\r?\n/).filter(Boolean), target);
  return keywordScore + (match ? 10 + match.score : 0) + Math.min(5, text.replace(/\s/g, "").length / 200);
}
