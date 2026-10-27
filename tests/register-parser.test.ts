import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { findTargetAnchorIndex, OCR_PAGE_BREAK, parseRegisterLines } from "../lib/register-parser.ts";

const sourceDir = "C:/Users/남정환/OneDrive - Daejoo Accounting Corporation/바탕 화면/Codex/재무제표소스/주주명부/제이비개인투자조합제2호";

async function layoutLines(fileName: string) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.isAbsolute(fileName) ? fileName : path.join(sourceDir, fileName))) }).promise;
  const output: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    const items = content.items.filter((item) => "str" in item && item.str.trim() && "transform" in item)
      .map((item) => ({ text: "str" in item ? item.str.trim() : "", x: item.transform[4], y: item.transform[5] }))
      .sort((left, right) => Math.abs(right.y - left.y) > 3 ? right.y - left.y : left.x - right.x);
    const rows: Array<{ y: number; cells: typeof items }> = [];
    for (const item of items) {
      let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
      if (!row) { row = { y: item.y, cells: [] }; rows.push(row); }
      row.cells.push(item);
    }
    output.push(...rows.sort((left, right) => right.y - left.y)
      .map((row) => row.cells.sort((left, right) => left.x - right.x).map((cell) => cell.text).join("\t")));
  }
  return output;
}

const cases = [
  ["1-2. 주주명부_(주)시크한_2025.12.31.pdf", 40_790, 520_000, "상환전환우선주"],
  ["1-2. 주주명부 _바이엘티.pdf", 500, 10_700, "전환우선주"],
  ["2. 주주명부 (2025.12.31).pdf", 2_500, 53_334, "상환전환주"],
  ["2. (주)워터블 주주명부(26.02.26).pdf", 28_900, 314_900, "주식종류 미표시"],
] as const;

for (const [fileName, owned, total, shareClass] of cases) {
  test(fileName, async () => {
    const result = parseRegisterLines(await layoutLines(fileName), "JB기술지주 개인투자조합");
    assert.equal(result.owned, owned);
    assert.equal(result.total, total);
    assert.equal(result.holdings[0]?.shareClass, shareClass);
  });
}

test("OCR-style 에코펨 text", () => {
  const lines = ["제이비(JB)기술지주 개인투자조합 제2호 상환전환우선주 1,500주 4.55%", "주식총수 33,000주"];
  const result = parseRegisterLines(lines, "JB기술지주 개인투자조합");
  assert.equal(result.owned, 1_500);
  assert.equal(result.total, 33_000);
});

test("rotated OCR-style 넥스첨단소재 text", () => {
  const lines = ["제이비(JB)기술지주 개인투자조합 제2호 상환전환우선주 1,500주", "합계 12,000주"];
  const result = parseRegisterLines(lines, "JB기술지주 개인투자조합");
  assert.equal(result.owned, 1_500);
  assert.equal(result.total, 12_000);
});

test("real OCR recovery fixtures", () => {
  const fixtures = [
    [["로 간 청 년 창 업 투 자 조 합", "(402-80-53501)", "268,241 268,241", "합계 40,706,964주"], 268_241, 40_706_964],
    [["로 간 청 년 창 업 투 자 조 합", "4,320", "총 발행주식수 221,150주"], 4_320, 221_150],
    [["로 간 청 년 창 업 투 자 조 합", "3,000", "총 발행주식수 29,816주"], 3_000, 29_816],
    [["로간청년창업투자조합 402-80-53501 20,800", "총 발행주식수 270,800주"], 20_800, 270_800],
  ] as const;
  for (const [lines, owned, total] of fixtures) {
    const result = parseRegisterLines([...lines], "로간 청년창업투자조합");
    assert.equal(result.owned, owned);
    assert.equal(result.total, total);
  }
});
test("총계와 합계 행을 총발행주식수로 인식한다", () => {
  const cases = [
    [["로간 청년창업투자조합 289,855주", "총 계 2,331,595 500 1,165,797,500"], 2_331_595],
    [["로간 청년창업투자조합 3,000", "합계 29,816 1주의금액 5,000원"], 29_816],
  ] as const;
  for (const [lines, expected] of cases) {
    assert.equal(parseRegisterLines([...lines], "로간 청년창업투자조합").total, expected);
  }
});
test("리킷 권리확정주식수 열 합계", async () => {
  const file = "C:/Users/남정환/OneDrive - Daejoo Accounting Corporation/바탕 화면/Codex/재무제표소스/주주명부/로간청년창업투자조합/(주)리킷 주주명부 2025.12.31.pdf";
  const result = parseRegisterLines(await layoutLines(file), "로간 청년창업투자조합");
  assert.equal(result.owned, 1_910_000);
  assert.equal(result.total, 23_822_322);
});

test("합계와 수량이 다음 줄이어도 총발행주식수로 인식한다", () => {
  const result = parseRegisterLines(["로간 청년창업투자조합", "3,000", "합계", "29,816", "1주의 금액 5,000원"], "로간 청년창업투자조합");
  assert.equal(result.total, 29_816);
});
test("길인터내셔널: 주소로 분리된 주주명과 주 단위를 인식한다", () => {
  const lines = ["로 간 청 년 창 업 투", "전라북도 전주시 덕진구", "자 조 합", "402-80-53501", "500 원", "36,363 주", "18,181,500 원", "합 계", "500 원", "164,244 주", "82,122,000 원"];
  const result = parseRegisterLines(lines, "로간 청년창업투자조합");
  assert.equal(result.owned, 36_363);
  assert.equal(result.total, 164_244);
});
test("스탠다드프렌즈: 증자후주식수 열의 최종값을 총발행주식수로 인식한다", () => {
  const lines = [
    "로 간 청 년 창 업 투 자 조 합", "268241 268241 우선주",
    "증 자 전 주 식 수 증 자 시 청 약 수 증 자 후 주 식 수 비고",
    "3500482 536482 4076964",
    "합계 금 2038482000 원정",
  ];
  const result = parseRegisterLines(lines, "로간 청년창업투자조합");
  assert.equal(result.owned, 268_241);
  assert.equal(result.total, 4_076_964);
});
test("에코펨: 분리된 주주총수와 주로 오인된 끝자리를 인식한다", () => {
  const result = parseRegisterLines(["제이비기술지주 개인투자조합 제2호 상환전환우선주 1,500주", "주 주 총 수", "수 33,0007", "33,000,000원"], "제이비기술지주개인투자조합제2호");
  assert.equal(result.owned, 1_500);
  assert.equal(result.total, 33_000);
});

test("넥스첨단소재: 회전 희소 OCR의 마지막 독립 주식수를 총수로 인식한다", () => {
  const result = parseRegisterLines(["제이비기술지주 개인투자조합 제2호 상환전환우선주 1,500주", "5,000원", "7,500,000원", "주식회사 디폰 500주", "12,000 주", "60,000,000원"], "제이비기술지주개인투자조합제2호");
  assert.equal(result.owned, 1_500);
  assert.equal(result.total, 12_000);
});
test("넥스첨단소재: OCR이 만든 비정상 초대형 숫자를 총주식수에서 제외한다", () => {
  const result = parseRegisterLines(["제이비기술지주 개인투자조합 제2호 상환전환우선주 1,500주", "24,624,026,966,233,000,000,000,000,000,000,000,000,000", "12,000 주", "60,000,000원"], "제이비기술지주개인투자조합제2호");
  assert.equal(result.owned, 1_500);
  assert.equal(result.total, 12_000);
});

test("매츠 ABB 명칭 사이에 OCR 오인식과 행 정보가 끼어도 찾는다", () => {
  const lines = [
    "매 츠 ㅅ88 테 크 제 1 호 벤",
    "5 181-80-02712 보 통 주 식 2,500 2.14%",
    "처 투 자 조 합",
    "합 계 116,600 100.00%",
  ];
  const result = parseRegisterLines(lines, "매츠ABB테크제1호벤처투자조합");
  assert.equal(result.owned, 2_500);
  assert.equal(result.total, 116_600);
});

test("주주 행의 퍼센트 직전 숫자를 보유주식수로 선택한다", () => {
  const lines = [
    "11 매츠488테크 제1호 벤처투자조합 우선주 3,879 2.25%",
    "13 다른개인투자조합 우선주 3,000 1.74%",
    "합계 172,216 100.00%",
  ];
  const result = parseRegisterLines(lines, "매츠ABB테크제1호벤처투자조합");
  assert.equal(result.owned, 3_879);
  assert.equal(result.total, 172_216);
});

test("종류별 소계보다 총계를 총발행주식수로 우선한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 우선주 144,970주 3.128%",
    "우선주 합계 1,895,872주 40.90%",
    "보통주 합계 2,739,376주 59.10%",
    "총계 4,635,248주 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 144_970);
  assert.equal(result.total, 4_635_248);
});

test("주주명 앞부분이 깨져도 뒤쪽의 긴 이름 조각으로 보강 OCR 위치를 찾는다", () => {
  const lines = [
    "5 | smat suns digital",
    "제이와이피 투자조합",
    "무선주 144,970주 3.128%",
  ];
  assert.equal(findTargetAnchorIndex(lines, "스마트엘앤에스-제이와이피투자조합"), 0);
});

test("주주명 매칭에 실패해도 강한 근거의 총발행주식수는 보존한다", () => {
  const result = parseRegisterLines([
    "우선주 합계 1,895,872주 40.90%",
    "보통주 합계 2,739,376주 59.10%",
    "총계 4,635,248주 100%",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.nameMatch, "실패");
  assert.equal(result.owned, null);
  assert.equal(result.total, 4_635_248);
});

test("주주명 매칭 실패 시 종류별 소계 하나나 마지막 숫자는 전체 총계로 보존하지 않는다", () => {
  const result = parseRegisterLines([
    "우선주 합계 1,895,872주 40.90%",
    "9,999,999",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.nameMatch, "실패");
  assert.equal(result.total, null);
});

test("OCR이 우선주를 무선주로 읽어도 우선주로 복구한다", () => {
  const result = parseRegisterLines([
    "스마트 엘앤에스-제이와이피 투자조합 무 선 주 144,970주 3.128%",
    "총계 4,635,248주 100%",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.deepEqual(result.holdings, [{ shareClass: "우선주", shares: 144_970 }]);
});

test("OCR이 우선주를 우서주로 읽어도 대상 행 안에서 우선주로 복구한다", () => {
  const result = parseRegisterLines([
    "스마트 엘앤에스-제이와이피 투자조합 우 서 주 144,970주 3.128%",
    "총계 4,635,248주 100%",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.deepEqual(result.holdings, [{ shareClass: "우선주", shares: 144_970 }]);
});

test("희소 OCR이 대상명·종류·수량·지분율을 각각 다른 줄로 읽어도 결합한다", () => {
  const result = parseRegisterLines([
    "스 마 트 엘 앤 에 스 - 제 이 와 이 피 투 자 조 합",
    "573-80-01983",
    "우 선 주",
    "144,970",
    "3.128%",
    "총 계",
    "4,635,248주 100%",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.deepEqual(result.holdings, [{ shareClass: "우선주", shares: 144_970 }]);
  assert.equal(result.total, 4_635_248);
});

test("흔한 스마트·투자조합 조각만 같은 다른 주주를 대상으로 오인하지 않는다", () => {
  const result = parseRegisterLines([
    "스마트 성장지원 투자조합 우선주 144,970주 3.128%",
    "총계 4,635,248주 100%",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.nameMatch, "실패");
  assert.equal(result.owned, null);
  assert.equal(result.total, 4_635_248);
});

test("한 종류의 합계 글자가 깨져도 인접 소계 수량과 비율로 총계를 복원한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 우선주 144,970주 3.128%",
    "edz Em I 1,895,872 40.90%",
    "보통주 합계 2,739,376 59.10%",
    "총계 4,685,248 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.total, 4_635_248);
});

test("100퍼센트가 없는 합성 총계보다 원본 총계 후보를 우선한다", () => {
  const lines = [
    "총발행주식수 4,545,248주",
    "스마트 엘앤에스-제이와이피 투자조합 우선주 144,970주 3.128%",
    "총계 4,635,248 100%",
    "총계 4,685,248 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.total, 4_635_248);
});

test("대상 행 지분율과 모순되는 총계의 한 자리 OCR 오류를 교정한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 우선주 144,970주 3.128%",
    "총계 4,685,248 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.total, 4_635_248);
});

test("병합된 주주명 아래 두 종류 주식을 모두 합산한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합",
    "2,737주 금1,000원 금2,737,000원 전환우선주 1.08%",
    "911주 금1,000원 금911,000원 보통주식 0.36%",
    "합계 254,129주 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.deepEqual(result.holdings, [
    { shareClass: "전환우선주", shares: 2_737 },
    { shareClass: "보통주", shares: 911 },
  ]);
  assert.equal(result.owned, 3_648);
  assert.equal(result.total, 254_129);
});

test("램쉽: 첫 종류 행에 지분율이 있어도 병합된 다음 종류 행까지 보존한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체 상생 투자조합",
    "보통주 18,300주 2.44%",
    "우선주 31,250주 4.17%",
    "다음주주 주식회사 보통주 12,950주 1.73%",
    "합계 749,475주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "보통주", shares: 18_300 },
    { shareClass: "우선주", shares: 31_250 },
  ]);
  assert.equal(result.owned, 49_550);
  assert.equal(result.total, 749_475);
});

test("램쉽 희소 OCR: 멀리 갈라진 상생 투자조합 이름 뒤의 두 번째 종류를 보존한다", () => {
  const result = parseRegisterLines([
    "0.19%",
    "500",
    "712,500",
    "2.44%",
    "500",
    "엘 앤 에 스 시 스 템 반 도 체 상",
    "보 통 주",
    "18,300",
    "9,150,000",
    "47",
    "449-80-*****",
    "생 투 자 조 합",
    "우 선 주",
    "31,250",
    "4.17%",
    "500",
    "15,625,000",
    "다음 주주 우선주 31,250주 4.17%",
    "합계 749,475주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "보통주", shares: 18_300 },
    { shareClass: "우선주", shares: 31_250 },
  ]);
  assert.equal(result.owned, 49_550);
  assert.equal(result.total, 749_475);
  assert.ok(Math.abs((result.ratio ?? 0) - 6.611294572867673) < 0.000001);
  assert.equal(result.confidence, "높음");
});

test("다중 종류의 합산 지분율에 직전 주주의 지분율을 더하지 않는다", () => {
  const result = parseRegisterLines([
    "이전주주 보통주 1,000주 10.00%",
    "엘앤에스 시스템반도체 상생 투자조합",
    "보통주 300주",
    "우선주 200주",
    "5.00%",
    "합계 10,000주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "보통주", shares: 300 },
    { shareClass: "우선주", shares: 200 },
  ]);
  assert.equal(result.owned, 500);
  assert.equal(result.total, 10_000);
  assert.equal(result.ratio, 5);
  assert.equal(result.confidence, "높음");
});

test("옵토레인: 병합된 두 종류만 읽고 다음 주주의 180,000주는 제외한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체 상생 투자조합",
    "보통주식",
    "61,729",
    "1.17%",
    "상환전환우선주식",
    "129,938",
    "28",
    "정점규",
    "보통주식",
    "180,000",
    "1.10%",
    "합계 16,397,076주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "보통주", shares: 61_729 },
    { shareClass: "상환전환우선주", shares: 129_938 },
  ]);
  assert.equal(result.owned, 191_667);
  assert.equal(result.total, 16_397_076);
});

test("옵토레인 희소 OCR: 회사명 앞에 열 우선 순서로 나온 두 종류를 복원한다", () => {
  const result = parseRegisterLines([
    "상환전환우선주식",
    "129,938",
    "보통주식",
    "61,729",
    "엘앤에스 시스템반도체 상생 투자조합",
    "1.17%",
    "상환전환우선주식",
    "129,938",
    "28",
    "정점규",
    "보통주식",
    "180,000",
    "1.10%",
    "합계 16,397,076주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "상환전환우선주", shares: 129_938 },
    { shareClass: "보통주", shares: 61_729 },
  ]);
  assert.equal(result.owned, 191_667);
  assert.equal(result.total, 16_397_076);
});

test("대상 지분율만 보이고 다음 주주가 이어지면 다음 주주 수량을 빌리지 않는다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체 상생 투자조합 1.17%",
    "28 정점규 보통주식 180,000주 1.10%",
    "합계 16,397,076주 100%",
  ], "엘앤에스시스템반도체");
  assert.equal(result.owned, null);
  assert.deepEqual(result.holdings, []);
  assert.equal(result.confidence, "확인 필요");
});

test("랩투마켓: 수량이 각 주식종류 앞에 있어도 일대일로 연결한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체 상생 투자조합 44,020주 (보통주) 491,195주 (상환전환우선주) 6.86%",
    "합계 7,796,849주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "보통주", shares: 44_020 },
    { shareClass: "상환전환우선주", shares: 491_195 },
  ]);
  assert.equal(result.owned, 535_215);
  assert.equal(result.total, 7_796_849);
});

test("랩투마켓 실제 PDF: 대상명과 운용사 행 사이의 선행 수량을 뒤 종류와 연결한다", () => {
  const result = parseRegisterLines([
    "엘 앤에스 시스 템반도 체",
    "44,020\t주",
    "상생 투자조합 : 엘앤에스벤처캐피탈 주식회사",
    "( 보통주 )",
    "100 원",
    "업무집행조합원 주소 서울특별시",
    "491,195\t주",
    "엘앤에스벤처캐피탈 주식회사",
    "( 상환전환 우선주 )",
    "다음주주 주식회사",
    "합 계 (총 주식수) 7,796,849 주",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "보통주", shares: 44_020 },
    { shareClass: "상환전환우선주", shares: 491_195 },
  ]);
  assert.equal(result.owned, 535_215);
  assert.equal(result.total, 7_796_849);
});

test("넥스젠파워: 같은 주주의 제2종과 제5종을 별도 종류로 보존한다", () => {
  const result = parseRegisterLines([
    "3 엘앤에스 시스템반도체 상생 투자조합 제2종 상환전환우선주식 2,000주 5.67%",
    "4 다른주주 제2종 상환전환우선주식 1,000주 2.83%",
    "9 엘앤에스 시스템반도체 상생 투자조합 제5종 상환전환우선주식 309주 0.88%",
    "10 또다른주주 제5종 상환전환우선주식 500주 1.42%",
    "합계 35,295주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "제2종 상환전환우선주", shares: 2_000 },
    { shareClass: "제5종 상환전환우선주", shares: 309 },
  ]);
  assert.equal(result.owned, 2_309);
  assert.equal(result.total, 35_295);
});

test("넥스젠파워 희소 OCR: 분리된 제N종과 AHA 오독 및 한글 액면가를 복원한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체",
    "제 2 종",
    "상환전환우선주식",
    "2,000",
    "20,000,000",
    "5.7%",
    "상생 투자조합",
    "기술보증기금 제3종 상환전환우선주식 2,000 5.7%",
    "AHA 시스템반도체",
    "제 5 종",
    "상환전환우선주식",
    "309",
    "3,090,000",
    "0.9%",
    "상생 투자조합",
    "다음주주 제5종 상환전환우선주식 928 2.6%",
    "합",
    "계",
    "35,295",
    "352,950,000",
    "100%",
    "(1 주 의 금 액",
    "금 일 만 원)",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "제2종 상환전환우선주", shares: 2_000 },
    { shareClass: "제5종 상환전환우선주", shares: 309 },
  ]);
  assert.equal(result.owned, 2_309);
  assert.equal(result.total, 35_295);
});

test("에티포스: 한 주주 셀의 제3종과 제4종을 별도 종류로 보존한다", () => {
  const result = parseRegisterLines([
    "제4종 상환전환우선주식 4,167주",
    "제3종 상환전환우선주식",
    "5,000",
    "엘앤에스 시스템반도체",
    "9 449-80-02132 3.80",
    "상생 투자조합",
    "제4종 상환전환우선주 4,166주 3.80%",
    "다음주주 보통주 10,000주 4.15%",
    "합계 241,206주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "제3종 상환전환우선주", shares: 5_000 },
    { shareClass: "제4종 상환전환우선주", shares: 4_166 },
  ]);
  assert.equal(result.owned, 9_166);
  assert.equal(result.total, 241_206);
});

test("블루닷 OCR: 띄어진 회사명과 분리된 종류·수량을 결합한다", () => {
  const result = parseRegisterLines([
    "엘 앤 에 스 시 스 템 반 도 체 상 생 투 자 조 합",
    "전환우선주",
    "59,101",
    "4.602%",
    "합계 1,284,149주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "전환우선주", shares: 59_101 }]);
  assert.equal(result.owned, 59_101);
  assert.equal(result.total, 1_284_149);
  assert.ok(Math.abs((result.ratio ?? 0) - 4.602347546896817) < 0.000001);
  assert.equal(result.confidence, "높음");
});

test("블루닷 희소 OCR: 국적과 조합 구분을 다음 주주로 오인하지 않는다", () => {
  const result = parseRegisterLines([
    "엘 앤 에 스 시 스 템 반 도",
    "449-80-02132",
    "대 한 민 국",
    "조 합 ( 펀 드 )",
    "전환우선주",
    "59,101",
    "500",
    "29,550,500",
    "4.602",
    "체 상생 투자조합",
    "10 포스텍홀딩스3호투자조합",
    "합계 1,284,149주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "전환우선주", shares: 59_101 }]);
  assert.equal(result.owned, 59_101);
  assert.equal(result.total, 1_284_149);
  assert.ok(Math.abs((result.ratio ?? 0) - 4.602347546896817) < 0.000001);
  assert.equal(result.confidence, "보통");
});

test("잇다반도체: 수량 뒤에 붙은 RCPS 종류를 보존한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체 성장 투자조합 9,671주 7.29% RCPS",
    "합계 132,676주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 9_671 }]);
  assert.equal(result.total, 132_676);
});

test("완결된 대상 행 뒤의 다른 주주 주식은 합산하지 않는다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 상환전환우선주식 3,551주 2.06%",
    "에스에이치투자파트너스 주식회사 보통주식 1,450주 0.84%",
    "합계 172,692주 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 3_551 }]);
  assert.equal(result.owned, 3_551);
});

test("100퍼센트 행의 마지막 합계 열을 총발행주식수로 선택한다", () => {
  const lines = [
    "보통주 우선주 합계",
    "스마트 엘앤에스-제이와이피 투자조합 4,667 4,667 1.80%",
    "162,214 97,488 259,702 100%",
    "합계",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 4_667);
  assert.equal(result.total, 259_702);
});

test("점으로 읽힌 천 단위 보유주식수를 복원한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 보통주식 61.729 0.38%",
    "합계 16,397,076주 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 61_729);
  assert.equal(result.total, 16_397_076);
});

test("액면가와 금액이 있는 100퍼센트 행에서 주식수 열을 선택한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 우선주 500원 75,702 37,851,000 1.04%",
    "합계 500원 7,278,282 3,639,141,000원 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 75_702);
  assert.equal(result.total, 7_278_282);
});

test("발행주식수 직접 표기를 총발행주식수로 인식한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 우선주 981주 1.70%",
    "발행주식수 : 57,725주",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 981);
  assert.equal(result.total, 57_725);
});

test("주식종류가 생략된 행에서도 액면가 곱셈으로 보유수량과 합계를 구분한다", () => {
  const lines = [
    "33 스마트 엘앤에스-제이와이피 투자조합 2,662 5,000 13,310,000 1.52%",
    "합계 175,176 875,880,000 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 2_662);
  assert.equal(result.total, 175_176);
});

test("종류별 소계의 상호보완 지분율로 전체 총계를 복원한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 41,667 0.90% 500 20,833,500 전환우선주",
    "보통주 소계 4,105,366 88.70% 2,052,683,000",
    "우선주 소계 523,109 11.30% 261,554,500",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 41_667);
  assert.equal(result.total, 4_628_475);
});

test("총주식수 열 머리글 뒤 첫 주주를 총계로 오인하지 않는다", () => {
  const lines = [
    "주주명 주식종류 주식수 총주식수 지분율",
    "스마트 엘앤에스-제이와이피 투자조합 우선주 1,630 1,630 4.57%",
    "다른주주 보통주 10,218 10,218 28.66%",
    "합 계 35,647 35,647 10000",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 1_630);
  assert.equal(result.total, 35_647);
});

test("표 하단 총계의 두 자리 OCR 오류를 여러 지분율로 교정한다", () => {
  const lines = [
    "주주명 주식종류 주식수 총주식수 지분율",
    "스마트 엘앤에스-제이와이피 투자조합 우선주 1,630 1,630 457%",
    "대웅제약 우선주 1,629 1,629 4.57%",
    "기술보증기금 우선주 1,629 1,629 4.57%",
    "다른주주 10,218 10,218 28.66%",
    "다른주주 4,069 4,069 11.41%",
    "다른주주 3,281 3,281 9.20%",
    "다른주주 3,260 3,260 9.15%",
    "다른주주 2,950 2,950 8.28%",
    "다른주주 1,630 1,630 4.57%",
    "다른주주 1,000 1,000 2.81%",
    "다른주주 814 814 2.28%",
    "다른주주 420 420 1.18%",
    "다른주주 325 325 0.91%",
    "SE nea 55607 10000",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 1_630);
  assert.equal(result.total, 35_647);
});

test("다른 OCR 후보에 분리된 총계 숫자를 100퍼센트 행으로 복원한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 우선주 1,189 4.00%",
    "일자리 창출 성장지원 우선주 1,189 4.00%",
    "인포뱅크(주) 보통주 934 3.14%",
    "Deblock Fund, LP. 보통주 770 ase%",
    "용지현 보통주 60 020%",
    "하상우 보통주 40 0.13%",
    "다른주주 보통주 40 0.13%",
    "박세웅 보통주 20 0.07%",
    "이윤호 보통주 3813 12.83%",
    "케이디비씨 투자조합 우선주 3500 12.00%",
    "노틸러스 투자조합 우선주 2,284 7.68%",
    "다른주주 보통주 1396 4.70%",
    "총 100%",
    "심충보 보통주 14,423 48.5296%",
    "29,724 100% 2",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 1_189);
  assert.equal(result.total, 29_724);
});

test("대상 지분율이 다음 줄이면 다음 주주의 다른 종류를 합산하지 않는다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 전환상환우선주식 3,551주",
    "2.06%",
    "에스에이치투자파트너스 주식회사 보통주식 1,450주 0.84%",
    "합계 172,692주 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 3_551 }]);
  assert.equal(result.owned, 3_551);
});

test("전환상환우선주 표기를 상환전환우선주로 정규화한다", () => {
  const result = parseRegisterLines([
    "스마트 엘앤에스-제이와이피 투자조합 전환상환우선주식 3,551주 2.06%",
    "합계 172,692주 100%",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 3_551 }]);
});

test("여러 점으로 읽힌 천 단위 총발행주식수를 복원한다", () => {
  const lines = [
    "스마트 엘앤에스-제이와이피 투자조합 보통주식 61.729 0.38%",
    "합계 16.397.076 100%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 61_729);
  assert.equal(result.total, 16_397_076);
});

test("여러 100퍼센트 OCR 후보 중 대상 지분율과 맞는 총계를 선택한다", () => {
  const lines = [
    "38 스마트 엘앤에스-제이와이피 투자조합 보통주식 61.729 0.38%",
    "Po total 1e397076 100.00%",
    "Po total 1e397076 100.00%",
    "96.397.076 100.00%",
    "16,397,076 100.00%",
  ];
  const result = parseRegisterLines(lines, "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.owned, 61_729);
  assert.equal(result.total, 16_397_076);
});

test("문서에 인쇄된 지분율과 계산 지분율이 다르면 확인 필요로 표시한다", () => {
  const result = parseRegisterLines([
    "스마트 엘앤에스-제이와이피 투자조합 우선주 1,630주 4.57%",
    "합계 10,218주 100%",
  ], "스마트엘앤에스-제이와이피투자조합");
  assert.equal(result.confidence, "확인 필요");
  assert.match(result.note, /지분율/);
});

test("대상 직후의 같은 종류 주식을 다음 주주 수량으로 덮어쓰지 않는다", () => {
  const result = parseRegisterLines([
    "엘앤에스 글로벌",
    "619-80-01260\t상환전환우선주식\t37,956",
    "반도체성장 투자조합",
    "케이큐브 NEO 펀드\t598-80-00590\t상환전환우선주식\t12,652",
    "LB 넥스트유니콘펀드\t433-80-02229\t상환전환우선주식\t125,113",
    "1주의 금액 : 100원 합계 : 1,104,346",
  ], "엘앤에스글로벌반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 37_956 }]);
  assert.equal(result.total, 1_104_346);
});

test("종류별 수량과 금액이 함께 있는 합계행을 산술 검증한다", () => {
  const fixtures: Array<[string, number]> = [
    ["합계 297,143 179,952 2,385,475,000 100.00%", 477_095],
    ["합계 1,571,428 1,878,618 3,450,046 1,725,023,000 100%", 3_450_046],
    ["합계 3,444,350 115,386 19,230 1,789,483,000 100.0%", 3_578_966],
  ];
  for (const [totalLine, expected] of fixtures) {
    const result = parseRegisterLines([
      "엘앤에스 글로벌 반도체성장 투자조합 상환전환우선주 44,382주 9.30%",
      totalLine,
    ], "엘앤에스글로벌반도체");
    assert.equal(result.total, expected);
  }
});

test("주주수 100퍼센트 뒤의 주식수 합계를 선택한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 글로벌 반도체성장 투자조합 619-80-01260 1 0.10% 428,570 4.84%",
    "합계 971 100% 8,846,140 100.00%",
  ], "엘앤에스글로벌반도체");
  assert.equal(result.owned, 428_570);
  assert.equal(result.total, 8_846_140);
});

test("액면가와 금액 뒤에 종류가 있는 대상 행에서도 대상 수량을 선택한다", () => {
  const result = parseRegisterLines([
    "3 엘앤에스 글로벌 반도체 성장 투자조합 5,000 25,195 25,195 125,975,000 9.62% 우선주",
    "4 엘앤에스 소재부장 혁신기업 투자조합 5,000 25,195 25,195 125,975,000 9.62% 우선주",
    "6 케이런 1호 스타트업 투자조합 5,000 11,627 11,627 58,135,000 4.44% 우선주",
    "합계 262,023 262,023 1,310,115,000 100.00%",
  ], "엘앤에스글로벌반도체");
  assert.equal(result.owned, 25_195);
  assert.equal(result.total, 262_023);
});

test("합계 셀이 줄마다 분리돼도 액면가와 총금액으로 발행주식수를 검증한다", () => {
  const result = parseRegisterLines([
    "1 주 의 금 액 : 5,000 원",
    "엘 엔 에 스 글 로 벌 반 도 체 성장 투자조합",
    "44,382",
    "221,910,000",
    "9.30%",
    "합 Al",
    "297,143",
    "179,952",
    "2,385,475,000",
    "100.00%",
  ], "엘앤에스글로벌반도체");
  assert.equal(result.owned, 44_382);
  assert.equal(result.total, 477_095);
});

test("수권주식수와 발행주식수가 함께 있어도 자본금 산술로 실제 발행주식수를 고른다", () => {
  const result = parseRegisterLines([
    "엘 엔 에 스 글 로 벌 반 도 체 성장 투자조합",
    "상환전환우선주",
    "2,476 (2.07%)",
    "1 주 의 금 액",
    "수 권 주 식 총 수",
    "발 행 주 식 총 수",
    "금 500원",
    "100,000,000주",
    "119,875주",
    "금 59,937,500원",
  ], "엘앤에스글로벌반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 2_476 }]);
  assert.equal(result.total, 119_875);
});

test("종류 셀이 지분율 뒤에 나오고 우선주가 으서주로 깨져도 대상 수량을 보존한다", () => {
  const result = parseRegisterLines([
    "엘 앤 메 스 글 로 벌 반 도 체 성 장 투 자 조 합",
    "3.58%",
    "상 환 전 환",
    "THT",
    "으 서 주",
    "195,100",
    "97,550,000",
    "10",
    "제이엑스 2호 투자조합",
    "총 주 식 수 5,451,517 100.00%",
  ], "엘앤에스글로벌반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 195_100 }]);
  assert.equal(result.total, 5_451_517);
});

test("깨진 우선주 셀 앞에 긴 OCR 잡음이 있어도 상환전환 문맥을 줄 기준으로 결합한다", () => {
  const result = parseRegisterLines([
    "엘 앤 에 스 글 로 벌 반 도 체 성 장 투 자 조 합",
    "3.58%",
    "상 환 전 환",
    "12345678901234567890 으 서 주",
    "195,100",
    "총 주 식 수 5,451,517 100.00%",
  ], "엘앤에스글로벌반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 195_100 }]);
  assert.equal(result.total, 5_451_517);
});

test("셀인셀즈 희소 OCR의 분리된 선행 종류 셀과 회사명 오독을 함께 복구한다", () => {
  const result = parseRegisterLines([
    "상환전환-",
    "우선주",
    "열앤메스글로벨반도체성장루자조합|",
    "195,100|",
    "97,550,000",
    "3.58%)",
    "총 주 식 수 5,451,517 100.00%",
  ], "엘앤에스글로벌반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 195_100 }]);
  assert.equal(result.total, 5_451_517);
});

test("대한민국 첫 글자가 빠진 희소 OCR에서도 뒤의 종류와 수량을 읽는다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도",
    "449-80-02132",
    "한민국",
    "조합(펀드)",
    "전환우선주",
    "59,101",
    "500",
    "29,550,500",
    "4.602%",
    "합계 1,284,149 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [{ shareClass: "전환우선주", shares: 59_101 }]);
  assert.equal(result.total, 1_284_149);
});

test("반복 대상의 투자조합 접미사와 종류가 같은 줄이어도 두 행을 합산한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체",
    "상생 투자조합 | 제2종 상환전환우선주식 | 2,000 | 20,000,000 | 5.7%",
    "기술보증기금 | 제3종 상환전환우선주식 | 2,000 | 20,000,000 | 5.7%",
    "엘앤에스 시스템반도체",
    "상생 투자조합 | 제5종 상환전환우선주식 | 309 | 3,090,000 | 0.9%",
    "합계 | 35,295 | 352,950,000 | 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "제2종 상환전환우선주", shares: 2_000 },
    { shareClass: "제5종 상환전환우선주", shares: 309 },
  ]);
  assert.equal(result.owned, 2_309);
  assert.equal(result.total, 35_295);
});

test("반복 대상 행의 종류 앞에 짧은 혼합 OCR 잡음이 있어도 두 번째 종류를 보존한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체 상생 투자조합",
    "제2종 상환전환우선주식 2,000 20,000,000 5.7%",
    "엘앤에스 시스템반도체 206",
    "르 yl 제5종 상환전환우선주식 309 3,090,000 0.9%",
    "합계 35,295 352,950,000 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "제2종 상환전환우선주", shares: 2_000 },
    { shareClass: "제5종 상환전환우선주", shares: 309 },
  ]);
  assert.equal(result.owned, 2_309);
  assert.equal(result.total, 35_295);
});

test("다음 OCR 페이지의 다른 종류는 대상 보유주식에 합산하지 않고 총계 교정에는 사용한다", () => {
  const result = parseRegisterLines([
    "엘앤에스 시스템반도체 상생 투자조합 제4종 상환전환우선주식 1,940주 0.12%",
    OCR_PAGE_BREAK,
    "다른주주 제5종 상환전환우선주식 4주 0.003%",
    "다른주주 제3종 상환전환우선주식 25주 0.002%",
    "다른주주 보통주 40,000주 2.57%",
    "다른주주 보통주 30,442주 1.96%",
    "다른주주 보통주 58,195주 3.74%",
    "다른주주 보통주 238,000주 15.29%",
    "총합계 4,556,321주 100%",
  ], "엘앤에스시스템반도체");
  assert.deepEqual(result.holdings, [
    { shareClass: "제4종 상환전환우선주", shares: 1_940 },
  ]);
  assert.equal(result.owned, 1_940);
  assert.equal(result.total, 1_556_321);
});

test("주소와 지분율 사이로 분리된 같은 주주의 종류와 수량을 연결한다", () => {
  const result = parseRegisterLines([
    "한빛웨이브 1 호",
    "서울특별시 가상구 예시대로 75길 25, 상환전환우선주식",
    "5 1 코노미투자조합 2019. 10. 12. 7.21%",
    "4 층 , 5 층 ( 예시동 ) 2,762 주",
    "다음투자조합",
    "상환전환우선주식 1,380주 3.60%",
    "보통주식 15,365주 / 자기주식 7,040주 / 전환상환우선주식 3,478주 /",
    "상환전환우선주식 8,284주 / 에이3의1종상환전환우선주식 2,182주 /",
    "합계",
    "에이3의2종상환전환우선주식 1,961주",
    "총 38,310주",
  ], "한빛웨이브1호");
  assert.deepEqual(result.holdings, [{ shareClass: "상환전환우선주", shares: 2_762 }]);
  assert.equal(result.total, 38_310);
  assert.equal(result.confidence, "높음");
});

test("한 줄에 여러 종류가 있는 총계 셀은 동일 종류 키로 덮어쓰지 않는다", () => {
  const result = parseRegisterLines([
    "한빛투자조합 상환전환우선주식 2,762주 7.21%",
    "보통주식 15,365주 / 자기주식 7,040주 / 전환상환우선주식 3,478주 /",
    "상환전환우선주식 8,284주 / 에이3의1종상환전환우선주식 2,182주 /",
    "합계",
    "에이3의2종상환전환우선주식 1,961주",
  ], "한빛투자조합");
  assert.equal(result.total, 38_310);
});

test("압축된 종류별 총계 주변의 대상 주주 수량을 총계에 다시 더하지 않는다", () => {
  const result = parseRegisterLines([
    "한빛투자조합 상환전환우선주식 2,762주 7.21%",
    "보통주식 15,365주 / 자기주식 7,040주 / 전환상환우선주식 3,478주 / 상환전환우선주식 8,284주 / 에이3의1종상환전환우선주식 2,182주 / 에이3의2종상환전환우선주식 1,961주",
    "합계",
  ], "한빛투자조합");
  assert.equal(result.owned, 2_762);
  assert.equal(result.total, 38_310);
});

test("요약명부에 대상이 없으면 보유수를 추정하지 않고 인쇄 합계를 보존한다", () => {
  const result = parseRegisterLines([
    "주주명 권리확정 주식수 지분율",
    "1 대표주주 60,000 60.00%",
    "2 기관주주 30,000 30.00%",
    "3 기타주주 10,000 10.00%",
    "합계 100,000 100.00%",
  ], "한빛웨이브1호");
  assert.equal(result.nameMatch, "실패");
  assert.equal(result.owned, null);
  assert.equal(result.total, 100_000);
  assert.match(result.note, /요약 명부.*보유주식수를 확인할 수 없습니다/);
});

test("권리확정주식수 행을 더할 때 소계와 총계를 중복 합산하지 않는다", () => {
  const result = parseRegisterLines([
    "주주명 권리확정 주식수 지분율",
    "1 대표주주 60,000 60.00%",
    "2 기관주주 30,000 30.00%",
    "소계 90,000 90.00%",
    "3 기타주주 10,000 10.00%",
    "합계 100,000",
  ], "한빛웨이브1호");
  assert.equal(result.total, 100_000);
  assert.equal(result.owned, null);
});

test("대상이 없는 요약명부에서도 주주수 합계를 발행주식수로 오인하지 않는다", () => {
  const result = parseRegisterLines([
    "주주명 주주수 지분율 주식수 지분율",
    "합계 971 100% 8,846,140 100.00%",
  ], "한빛웨이브1호");
  assert.equal(result.owned, null);
  assert.equal(result.total, 8_846_140);
});

test("OCR의 숫자 뒤 흐·ㅎ 표기를 보정해 영문 세부종류 주식을 보존한다", () => {
  for (const suffix of ["흐", "ㅎ"]) {
    const result = parseRegisterLines([
      `한 빛 웨 미 브 1 ${suffix} 1 코 노 미`,
      "조 함",
      "제 11 에 이 종 전 환 우 선 주",
      "4,540",
      "0.41%",
      "다른성장투자조합",
      "제11비종 전환우선주 3,083주 0.28%",
      "합계 1,099,940주 100.00%",
    ], "한빛웨이브1호");
    assert.equal(result.nameMatch, "유사");
    assert.deepEqual(result.holdings, [{ shareClass: "제11에이종 전환우선주", shares: 4_540 }]);
    assert.equal(result.total, 1_099_940);
  }
});

test("주요 이름이 같아도 다른 호수나 공통 접미사만 있는 조합을 대상 주주로 읽지 않는다", () => {
  for (const otherName of ["한빛웨이브2호", "다른웨이브1호"]) {
    const result = parseRegisterLines([
      `${otherName} 전환우선주 4,540주 0.41%`,
      "합계 1,099,940주 100.00%",
    ], "한빛웨이브1호");
    assert.equal(result.nameMatch, "실패");
    assert.equal(result.owned, null);
  }
});
