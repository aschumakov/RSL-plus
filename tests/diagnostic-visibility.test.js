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

/* --- две волны публикации через настоящий координатор ---------------- */

const {
  DiagnosticsCoordinator
} = require("../server/out/diagnostics/diagnosticsCoordinator");
const {
  RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");
const {
  buildLocalRslDiagnostics,
  buildWorkspaceRslDiagnostics
} = require("../server/out/diagnostics");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const diagnosticDefaults = {
  imports: { enabled: true },
  autoImport: { enabled: true },
  analysis: { workspaceIndexing: "activeImports" },
  semanticHighlighting: { maxFileSizeKb: 512 },
  diagnostics: {
    enabled: true,
    structure: true,
    unusedImports: true,
    ambiguousReferences: true,
    maxProblems: 200
  }
};

function createTestDocument(uri, version, source) {
  return {
    uri,
    languageId: "rsl",
    version,
    getText: () => source,
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0
  };
}

async function tick(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/*
 * Локальные правила не имеют права зависеть от готовности индекса.
 *
 * Ключ локального кэша состоит из версии документа и локальных настроек и
 * НЕ включает состояние Import-графа. Значит правило, чей результат меняется
 * после загрузки зависимостей, один раз посчитается и замолчит навсегда — до
 * следующей правки файла. Проверка ловит именно такую утечку: результат
 * локальной фазы обязан быть одинаковым при пустом и при заполненном индексе.
 */
async function testLocalPhaseIgnoresIndexState() {
  const uri = "file:///workspace/self.mac";
  const source = [
    "Import self;",
    "Import other;",
    "Import other;",
    "Macro Test()",
    "End;"
  ].join("\n");

  const emptyIndex = new WorkspaceIndex();
  const emptyModule = emptyIndex.updateOpenModule(uri, source, 1);
  const localWithoutIndex = buildLocalRslDiagnostics(
    emptyModule,
    emptyIndex,
    diagnosticDefaults.diagnostics
  );

  const readyIndex = new WorkspaceIndex();
  readyIndex.registerWorkspaceFiles([uri, "file:///workspace/other.mac"]);
  const readyModule = readyIndex.updateOpenModule(uri, source, 1);
  readyIndex.updateExternalModule(
    "file:///workspace/other.mac",
    "Macro Shared()\nEnd;",
    1
  );
  const localWithIndex = buildLocalRslDiagnostics(
    readyModule,
    readyIndex,
    diagnosticDefaults.diagnostics
  );

  assert.deepStrictEqual(
    localWithIndex.map(item => item.code).sort(),
    localWithoutIndex.map(item => item.code).sort(),
    "Локальная фаза не должна менять результат от состояния индекса: " +
      "её кэш пересчитывается только по версии документа"
  );

  /* Проверка, зависящая от каталога workspace, живёт в workspace-фазе. */
  const workspace = buildWorkspaceRslDiagnostics(
    readyModule,
    readyIndex,
    diagnosticDefaults.diagnostics
  );
  assert.ok(
    workspace.some(item => item.code === "self-import"),
    "self-import обязан приходить второй волной: он опирается на каталог " +
      "workspace, а не на текст текущего файла"
  );
  assert.ok(
    !localWithIndex.some(item => item.code === "self-import"),
    "self-import не должен оставаться в локальной фазе"
  );
}

/*
 * Problems покинутого файла не должны всплывать перед Problems нужного.
 *
 * Расчёт диагностики синхронный, поэтому уведомление о смене активного файла
 * всё это время лежит в очереди событий необработанным. Публикация успевала
 * пройти раньше него: в панели сначала появлялся список файла, из которого
 * пользователь уже ушёл, а через мгновение гасился — и только потом появлялся
 * нужный. Переключение здесь моделируется из buildLocal: именно так выглядит
 * сообщение, пришедшее во время расчёта.
 */
async function testAbandonedFileDiagnosticsAreNotPublished() {
  const first = "file:///workspace/first.mac";
  const second = "file:///workspace/second.mac";
  const sources = {
    [first]: "Macro First()\n  Var unusedFirst;\n  DebugBreak;\nEnd;",
    [second]: "Macro Second()\n  Var unusedSecond;\n  DebugBreak;\nEnd;"
  };
  const documents = new Map([
    [first, createTestDocument(first, 1, sources[first])],
    [second, createTestDocument(second, 1, sources[second])]
  ]);
  const index = new WorkspaceIndex();
  index.registerWorkspaceFiles([first, second]);
  for (const uri of [first, second]) {
    index.updateOpenModule(uri, sources[uri], 1);
  }

  const publications = [];
  let switched = false;
  let coordinator;
  coordinator = new DiagnosticsCoordinator(
    {
      sendDiagnostics: value => publications.push({
        uri: value.uri,
        count: value.diagnostics.length
      })
    },
    {
      get: uri => documents.get(uri),
      all: () => [...documents.values()]
    },
    index,
    { getAvailable: () => diagnosticDefaults },
    {
      buildLocal: (module, currentIndex, settings) => {
        if (module.uri === first && !switched) {
          switched = true;
          setImmediate(() => coordinator.setActiveDocument(second));
        }
        return buildLocalRslDiagnostics(module, currentIndex, settings);
      },
      buildWorkspace: (module, currentIndex, settings) =>
        buildWorkspaceRslDiagnostics(module, currentIndex, settings),
      buildLocalAsync(...args) {
          return Promise.resolve(this.buildLocal(...args));
      },
      buildWorkspaceAsync(...args) {
          return Promise.resolve(this.buildWorkspace(...args));
      }
    },
    {
      isParseBusy: () => false,
      waitForIdle: () => Promise.resolve(),
      log: () => undefined,
      onImports: () => undefined,
      localDebounceMs: 0,
      workspaceDebounceMs: 20,
      workspaceMaxWaitMs: 60
    }
  );

  coordinator.setActiveDocument(first);
  await tick(300);

  const leftovers = publications.filter(
    item => item.uri === first && item.count > 0
  );
  assert.deepStrictEqual(
    leftovers,
    [],
    "Problems файла, из которого пользователь ушёл, публиковаться не должны; " +
      `получено: ${JSON.stringify(publications)}`
  );
  assert.ok(
    publications.some(item => item.uri === second && item.count > 0),
    `Problems активного файла обязаны появиться: ${JSON.stringify(publications)}`
  );

  coordinator.close(first);
  coordinator.close(second);
}

/*
 * Порядок и устойчивость двух волн: сначала локальные ошибки текущей версии,
 * затем local + workspace той же версии. Пачка загруженных модулей обязана
 * объединяться в один пересчёт, а не публиковаться после каждого Import.
 */
async function testTwoWavePublicationIsStable() {
  const uri = "file:///workspace/main.mac";
  const source = [
    "Import library;",
    "Macro Caller()",
    "  SharedHandler(1);",
    "End;"
  ].join("\n");
  const document = createTestDocument(uri, 1, source);
  const index = new WorkspaceIndex();
  index.registerWorkspaceFiles([uri, "file:///workspace/library.mac"]);
  index.updateOpenModule(uri, source, 1);

  const publications = [];
  const phases = [];
  const coordinator = new DiagnosticsCoordinator(
    {
      sendDiagnostics: value => publications.push({
        uri: value.uri,
        codes: value.diagnostics.map(item => item.code)
      })
    },
    {
      get: requested => requested === uri ? document : undefined,
      all: () => [document]
    },
    index,
    { getAvailable: () => diagnosticDefaults },
    {
      buildLocal: (module, currentIndex, settings) => {
        phases.push("local");
        return buildLocalRslDiagnostics(module, currentIndex, settings);
      },
      buildWorkspace: (module, currentIndex, settings) => {
        phases.push("workspace");
        return buildWorkspaceRslDiagnostics(module, currentIndex, settings);
      },
      buildLocalAsync(...args) {
          return Promise.resolve(this.buildLocal(...args));
      },
      buildWorkspaceAsync(...args) {
          return Promise.resolve(this.buildWorkspace(...args));
      }
    },
    {
      isParseBusy: () => false,
      waitForIdle: () => Promise.resolve(),
      log: message => { throw new Error(message); },
      onImports: () => undefined,
      localDebounceMs: 0,
      workspaceDebounceMs: 120,
      workspaceMaxWaitMs: 400
    }
  );

  coordinator.setActiveDocument(uri);
  coordinator.scheduleLocal(uri, 0);
  coordinator.scheduleWorkspace(uri);
  await tick(40);

  assert.deepStrictEqual(
    phases,
    ["local"],
    "Первой волной обязаны идти локальные ошибки, без ожидания Import"
  );

  /* Индексация Import-графа: несколько модулей подряд. */
  for (let attempt = 0; attempt < 5; attempt++) {
    index.updateExternalModule(
      "file:///workspace/library.mac",
      "Macro SharedHandler(value)\nEnd;",
      attempt + 1
    );
    coordinator.scheduleWorkspace(uri, 120);
    await tick(30);
  }

  await tick(500);
  const workspaceRuns = phases.filter(item => item === "workspace").length;
  assert.ok(
    workspaceRuns >= 1,
    "Вторая волна обязана состояться"
  );
  assert.ok(
    workspaceRuns <= 2,
    "Пять загруженных модулей подряд обязаны объединяться в один-два " +
      `пересчёта, а не публиковаться каждый раз; получено ${workspaceRuns}`
  );

  /* Мерцание: ни одна публикация не должна быть пустой после первой волны. */
  const afterFirst = publications.slice(1);
  assert.ok(
    afterFirst.every(item => item.codes.length > 0),
    "После первой волны Problems не должны пропадать и появляться снова: " +
      JSON.stringify(publications)
  );

  /*
   * Версия документа сменилась, workspace-результат прежней версии не должен
   * попасть в публикацию: иначе в Problems смешались бы две версии файла.
   */
  const changed = createTestDocument(uri, 2, source + "\nMacro Added()\nEnd;");
  document.version = 2;
  document.getText = changed.getText;
  publications.length = 0;
  phases.length = 0;
  coordinator.scheduleWorkspace(uri, 0);
  await tick(80);

  assert.deepStrictEqual(
    phases,
    [],
    "Workspace-фаза не имеет права считаться для версии, которой нет в " +
      "индексе: результат относился бы к другому тексту"
  );
  assert.deepStrictEqual(
    publications,
    [],
    "Публикации для несуществующей версии быть не должно"
  );

  coordinator.close(uri);
}

(async () => {
  await testLocalPhaseIgnoresIndexState();
  passed++;
  console.log("[OK] локальная фаза не зависит от состояния индекса");

  await testTwoWavePublicationIsStable();
  passed++;
  console.log("[OK] две волны Problems: порядок, объединение, без мерцания");

  await testAbandonedFileDiagnosticsAreNotPublished();
  passed++;
  console.log("[OK] Problems покинутого файла не всплывают перед нужными");

  console.log("");
  console.log(`Пройдено: ${passed}`);
  console.log(`Ошибок: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
