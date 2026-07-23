"use strict";

const assert = require("assert");
const {
  planActiveDocumentDiagnostics,
  planUpdatedDiagnostics,
  resolveActiveDocumentUri
} = require("../server/out/diagnostics/diagnosticVisibility");

const activeUri = "file:///active.mac";
const otherUri = "file:///other.mac";
const openUris = [activeUri, otherUri];
const activeProblem = [{ code: "active-problem" }];
const otherProblem = [{ code: "other-problem" }];

function byUri(plan, uri) {
  const publication = plan.find(item => item.uri === uri);
  assert.ok(publication, `Не найдена публикация для ${uri}`);
  return publication.diagnostics;
}

let passed = 0;
let failed = 0;

function test(name, action) {
  try {
    action();
    passed++;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed++;
    console.error(`[FAIL] ${name}`);
    console.error(error);
  }
}

test("При открытии файла без кэша остальные Problems сразу скрываются", () => {
  const cache = new Map([[otherUri, otherProblem]]);
  const plan = planActiveDocumentDiagnostics(activeUri, openUris, cache);

  assert.deepStrictEqual(byUri(plan, activeUri), []);
  assert.deepStrictEqual(byUri(plan, otherUri), []);
});

test("Временный null не сбрасывает открытый активный RSL-файл", () => {
  let currentUri = resolveActiveDocumentUri(
    undefined,
    activeUri,
    openUris
  );
  assert.strictEqual(currentUri, activeUri);

  currentUri = resolveActiveDocumentUri(currentUri, null, openUris);
  assert.strictEqual(currentUri, activeUri);

  currentUri = resolveActiveDocumentUri(currentUri, undefined, openUris);
  assert.strictEqual(currentUri, activeUri);
});

test("Активный URI очищается после фактического закрытия файла", () => {
  const remainingUris = [otherUri];
  const resolved = resolveActiveDocumentUri(
    activeUri,
    null,
    remainingUris
  );

  assert.strictEqual(resolved, undefined);
});

test("Переключение на другой RSL-файл выполняется сразу", () => {
  const resolved = resolveActiveDocumentUri(
    activeUri,
    otherUri,
    openUris
  );

  assert.strictEqual(resolved, otherUri);
});

test("Пустой результат активного файла не возвращает ошибки других файлов", () => {
  const cache = new Map([
    [activeUri, []],
    [otherUri, otherProblem]
  ]);
  const plan = planActiveDocumentDiagnostics(activeUri, openUris, cache);

  assert.deepStrictEqual(byUri(plan, activeUri), []);
  assert.deepStrictEqual(byUri(plan, otherUri), []);
});

test("Кэш активного файла показывается, остальные файлы скрываются", () => {
  const cache = new Map([
    [activeUri, activeProblem],
    [otherUri, otherProblem]
  ]);
  const plan = planActiveDocumentDiagnostics(activeUri, openUris, cache);

  assert.strictEqual(byUri(plan, activeUri), activeProblem);
  assert.deepStrictEqual(byUri(plan, otherUri), []);
});

test("Фоновый расчёт неактивного файла не попадает в Problems", () => {
  const plan = planUpdatedDiagnostics(
    activeUri,
    otherUri,
    otherProblem,
    openUris
  );

  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].uri, otherUri);
  assert.deepStrictEqual(plan[0].diagnostics, []);
});

test("Пустая диагностика активного файла остаётся пустой", () => {
  const plan = planUpdatedDiagnostics(activeUri, activeUri, [], openUris);

  assert.deepStrictEqual(byUri(plan, activeUri), []);
  assert.deepStrictEqual(byUri(plan, otherUri), []);
});

test("Без активного RSL-файла обновлённая диагностика публикуется", () => {
  const plan = planUpdatedDiagnostics(
    undefined,
    otherUri,
    otherProblem,
    openUris
  );

  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].diagnostics, otherProblem);
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
  process.exitCode = 1;
}
