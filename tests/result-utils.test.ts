import assert from "node:assert/strict";
import test from "node:test";
import { encodeCsv, upsertById } from "../lib/result-utils.ts";

test("정밀 재분석은 같은 문서 결과를 원래 위치에서 교체한다", () => {
  const initial = [
    { id: "success", state: "완료", value: 100 },
    { id: "retry", state: "실패", value: null },
  ];
  const updated = upsertById(initial, { id: "retry", state: "완료", value: 200 });

  assert.equal(updated.length, 2);
  assert.deepEqual(updated.map((item) => item.id), ["success", "retry"]);
  assert.deepEqual(updated[0], initial[0]);
  assert.deepEqual(updated[1], { id: "retry", state: "완료", value: 200 });
});

test("파일명이 같아도 작업 ID가 다르면 별도 문서로 유지한다", () => {
  const initial = [{ id: "first", fileName: "같은이름.pdf", state: "실패" }];
  const updated = upsertById(initial, { id: "second", fileName: "같은이름.pdf", state: "완료" });
  assert.equal(updated.length, 2);
});

test("CSV에는 교체된 최신 결과만 기록된다", () => {
  const latest = upsertById(
    [{ id: "retry", fileName: "대상.pdf", state: "실패", note: "기본 분석 시간 30초 초과" }],
    { id: "retry", fileName: "대상.pdf", state: "완료", note: "정밀 재분석 완료" },
  );
  const csv = encodeCsv([
    ["파일", "상태", "메모"],
    ...latest.map((item) => [item.fileName, item.state, item.note]),
  ]);

  assert.equal((csv.match(/대상\.pdf/g) ?? []).length, 1);
  assert.doesNotMatch(csv, /30초 초과/);
  assert.match(csv, /정밀 재분석 완료/);
});

test("CSV 문자열이 스프레드시트 수식으로 실행되지 않도록 이스케이프한다", () => {
  const csv = encodeCsv([
    ["파일", "메모", "숫자"],
    ["=HYPERLINK(\"https://example.invalid\")", "  @SUM(1,1)", -123],
    ["+CMD", "-2+3", 456],
  ]);

  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
  assert.match(csv, /"' {2}@SUM\(1,1\)"/);
  assert.match(csv, /"'\+CMD"/);
  assert.match(csv, /"'-2\+3"/);
  assert.match(csv, /,"-123"/);
  assert.match(csv, /,"456"/);
});
