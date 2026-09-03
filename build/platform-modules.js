"use strict";

/**
 * Проверка и досчёт каталога прикладных модулей.
 *
 * Данные в platform-modules/ извлечены из руководства и правятся руками, а
 * связей между модулями в них больше, чем видно глазом: класс BankInter
 * наследует класс PaymInter, свойство ссылается на класс третьего модуля.
 * Незамеченная такая связь выглядит в редакторе не как ошибка данных, а как
 * молча пропавшие члены класса.
 *
 *   node build/platform-modules.js            — проверить, вывести отчёт
 *   node build/platform-modules.js --fix       — досчитать dependencies в index
 *
 * Проверяется:
 *   1. отсутствующие базовые классы;
 *   2. неизвестные типы членов и результатов процедур;
 *   3. циклы наследования;
 *   4. необъявленные межмодульные зависимости.
 */

const fs = require("fs");
const path = require("path");

const DIRECTORY = path.join(__dirname, "..", "platform-modules");
const INDEX_FILE = path.join(DIRECTORY, "index.json");
const SYMBOLS_FILE = path.join(DIRECTORY, "symbols.json");

/*
 * Версия обратного указателя.
 *
 * Своя, не общая с индексом: указатель — производное от тел модулей, и
 * пересобирается он отдельно. Несовпадение версии выключает только его.
 */
const SYMBOLS_VERSION = 1;

/*
 * Типы, которые не обязаны быть классом каталога: примитивы языка и типы,
 * которые справка пишет свободным текстом.
 */
const PRIMITIVE_TYPES = new Set([
    "variant", "integer", "double", "doublel", "string", "bool", "date",
    "time", "datetime", "dttm", "memaddr", "procref", "methodref",
    "decimal", "numeric", "money", "moneyl", "specval", "object", "r2m",
    "array", "record", "file", "void", "any", "genobj", "struc"
]);

/**
 * Классы, которые руководство упоминает, но своим разделом не описывает.
 *
 * Ссылка на них — не опечатка в данных: состава у этих классов в руководстве
 * просто нет, поэтому проверка на них не срабатывает. Список ведётся руками
 * именно для того, чтобы новая необъявленная ссылка сразу становилась ошибкой,
 * а не тонула в общем шуме.
 */
const UNDOCUMENTED_TYPES = new Set([
    /* Списки объектов эквайринга: упомянуты как тип свойства. */
    "tacqacclist",
    "tacqcurrlist",
    /* Запись эквайринга: своего раздела в руководстве нет. */
    "trec",
    /* Внутренние базовые классы платформы. */
    "rsltpersistvarrecord",
    "rsbobject"
]);

function lower(value) {
    return String(value || "").trim().toLowerCase();
}

/** Классы стандартной библиотеки: они видны без Import. */
function standardLibraryClasses() {
    const result = new Set();

    try {
        /* eslint-disable-next-line global-require */
        const { getDefaults } = require("../server/out/defaults");
        for (const item of getDefaults().completionItems) {
            result.add(lower(item.label));
        }
    } catch (error) {
        console.warn(
            "Стандартная библиотека не загружена (нужен npm run compile); " +
            "проверка неизвестных типов будет неполной."
        );
    }

    return result;
}

function readCatalog() {
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    const modules = new Map();

    for (const [name, entry] of Object.entries(index.modules || {})) {
        const body = JSON.parse(
            fs.readFileSync(path.join(DIRECTORY, entry.file), "utf8")
        );
        modules.set(lower(name), {
            name,
            entry,
            classes: body.classes || [],
            procedures: body.procedures || [],
            constants: body.constants || []
        });
    }

    return { index, modules };
}

/** Карта «имя класса → множество модулей, где он объявлен». */
function buildClassOwners(modules) {
    const owners = new Map();

    for (const [key, module] of modules) {
        for (const item of module.classes) {
            const name = lower(item.name);
            const set = owners.get(name) || new Set();
            set.add(key);
            owners.set(name, set);
        }
    }

    return owners;
}

function declaredDependencies(modules, key) {
    return (modules.get(key)?.entry.dependencies || []).map(lower);
}

/** Модуль и все его объявленные зависимости, транзитивно. */
function dependencyClosure(modules, key) {
    const visited = new Set();
    const queue = [key];

    while (queue.length > 0) {
        const current = queue.pop();

        if (visited.has(current)) {
            continue;
        }
        visited.add(current);
        queue.push(...declaredDependencies(modules, current));
    }

    return visited;
}

/**
 * Модуль, в котором стоит искать имя из модуля owner.
 *
 * Сначала сам owner: одинаковые имена классов в разных модулях — норма, и своё
 * всегда важнее чужого.
 */
function resolveOwner(modules, owners, ownerKey, name) {
    const candidates = owners.get(lower(name));

    if (!candidates) {
        return undefined;
    }
    if (candidates.has(ownerKey)) {
        return ownerKey;
    }

    const closure = dependencyClosure(modules, ownerKey);

    for (const candidate of closure) {
        if (candidates.has(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function collectProblems(modules, owners, standard) {
    const problems = [];
    const requiredDependencies = new Map();

    const require_ = (fromKey, toKey) => {
        if (fromKey === toKey) {
            return;
        }
        const set = requiredDependencies.get(fromKey) || new Set();
        set.add(toKey);
        requiredDependencies.set(fromKey, set);
    };

    for (const [key, module] of modules) {
        for (const item of module.classes) {
            /*
             * Класс каталога с именем стандартного «затеняет» его: разрешение
             * базы начинается с модуля-владельца, и заглушка из двух свойств
             * подменяет полное описание стандартной библиотеки. Именно так
             * TRecHandler в AcquirerObjects обрезал цепочку TAcqDocument.
             */
            if (standard.has(lower(item.name))) {
                problems.push({
                    kind: "duplicates-standard-class",
                    module: module.name,
                    detail: `${item.name} уже есть в стандартной библиотеке`
                });
            }

            if (!item.base) {
                continue;
            }

            const baseKey = lower(item.base);
            const candidates = owners.get(baseKey);

            if (UNDOCUMENTED_TYPES.has(baseKey)) {
                continue;
            }

            if (!candidates && !standard.has(baseKey)) {
                problems.push({
                    kind: "missing-base-class",
                    module: module.name,
                    detail: `${item.name} наследует неизвестный ${item.base}`
                });
                continue;
            }

            if (!candidates) {
                /* Базовый класс стандартной библиотеки: Import не нужен. */
                continue;
            }

            const resolved = resolveOwner(modules, owners, key, item.base);

            if (!resolved) {
                /*
                 * Класс существует, но не в этом модуле и не в его объявленных
                 * зависимостях: без записи в dependencies редактор не получит
                 * унаследованных членов.
                 */
                const target = candidates.values().next().value;
                require_(key, target);
                problems.push({
                    kind: "undeclared-dependency",
                    module: module.name,
                    detail: `${item.name} наследует ${item.base} из ` +
                        `${modules.get(target).name}, но зависимость не объявлена`
                });
            }
        }

        const typeReferences = [
            ...module.classes.flatMap(item =>
                (item.members || []).map(member => ({
                    type: member.typeName,
                    where: `${item.name}.${member.name}`
                }))
            ),
            ...module.procedures.map(item => ({
                type: trailingType(item.signature),
                where: item.name
            }))
        ];

        for (const reference of typeReferences) {
            const type = lower(reference.type).replace(/^@/, "");

            if (
                !type ||
                PRIMITIVE_TYPES.has(type) ||
                UNDOCUMENTED_TYPES.has(type) ||
                standard.has(type) ||
                owners.get(type)?.has(key)
            ) {
                continue;
            }

            if (!owners.has(type)) {
                problems.push({
                    kind: "unknown-type",
                    module: module.name,
                    detail: `${reference.where}: ${reference.type}`
                });
                continue;
            }

            if (!resolveOwner(modules, owners, key, type)) {
                const target = owners.get(type).values().next().value;
                require_(key, target);
                problems.push({
                    kind: "undeclared-type-dependency",
                    module: module.name,
                    detail: `${reference.where}: ${reference.type} из ` +
                        `${modules.get(target).name}`
                });
            }
        }
    }

    problems.push(...inheritanceCycles(modules, owners));
    return { problems, requiredDependencies };
}

function trailingType(signature) {
    const match = /:\s*(@?[\wА-Яа-яЁё]+)\s*$/u.exec(String(signature || ""));
    return match ? match[1] : "";
}

function inheritanceCycles(modules, owners) {
    const problems = [];
    const state = new Map();

    const classIn = (moduleKey, name) => modules
        .get(moduleKey)
        ?.classes.find(item => lower(item.name) === lower(name));

    const visit = (moduleKey, name, stack) => {
        const nodeKey = `${moduleKey}#${lower(name)}`;

        if (state.get(nodeKey) === "done") {
            return;
        }
        if (state.get(nodeKey) === "open") {
            problems.push({
                kind: "inheritance-cycle",
                module: modules.get(moduleKey).name,
                detail: [...stack, name].join(" -> ")
            });
            return;
        }

        state.set(nodeKey, "open");
        const item = classIn(moduleKey, name);

        if (item?.base) {
            const ownerKey = resolveOwner(
                modules,
                owners,
                moduleKey,
                item.base
            );

            if (ownerKey) {
                visit(ownerKey, item.base, [...stack, name]);
            }
        }
        state.set(nodeKey, "done");
    };

    for (const [key, module] of modules) {
        for (const item of module.classes) {
            visit(key, item.name, []);
        }
    }

    return problems;
}

/** Счётчики в index.json — справочные, но врать они не должны. */
function refreshCounters(index, modules) {
    let changed = false;

    for (const module of modules.values()) {
        const entry = index.modules[module.name];
        const counts = {
            classes: module.classes.length,
            procedures: (module.procedures || []).length,
            constants: (module.constants || []).length
        };

        for (const [field, value] of Object.entries(counts)) {
            if (entry[field] !== value) {
                entry[field] = value;
                changed = true;
            }
        }
    }

    return changed;
}

/**
 * Досчёт dependencies до неподвижной точки.
 *
 * Одна итерация может открыть следующую: объявив BankInter -> PaymInter, мы
 * делаем видимыми базовые классы PaymInter, а у них могут быть свои.
 */
function fixDependencies(index, modules, owners) {
    let changed = refreshCounters(index, modules);

    for (let pass = 0; pass < 10; pass++) {
        const { requiredDependencies } = collectProblems(
            modules,
            owners,
            new Set()
        );

        if (requiredDependencies.size === 0) {
            break;
        }

        for (const [fromKey, targets] of requiredDependencies) {
            const module = modules.get(fromKey);
            const existing = new Set(
                (module.entry.dependencies || []).map(lower)
            );

            for (const target of targets) {
                if (existing.has(target)) {
                    continue;
                }
                existing.add(target);
                changed = true;
            }

            module.entry.dependencies = Array.from(existing)
                .map(key => modules.get(key).name)
                .sort((left, right) => left.localeCompare(right));
            index.modules[module.name].dependencies =
                module.entry.dependencies;
        }
    }

    if (changed) {
        fs.writeFileSync(
            INDEX_FILE,
            `${JSON.stringify(index, null, 1)}\n`,
            "utf8"
        );
    }

    return changed;
}

/**
 * Обратный указатель: нормализованное имя -> модули, где оно объявлено.
 *
 * Пишутся все объявления модуля — классы, процедуры и константы: искать
 * будут по любому из них. Имя нормализуется так же, как в языке: RSL
 * сравнивает имена без учёта регистра.
 */
function buildSymbolOwners(modules) {
    const owners = new Map();
    const add = (name, moduleName) => {
        const key = lower(String(name || ""));

        if (!key) {
            return;
        }

        const list = owners.get(key) || new Set();

        list.add(moduleName);
        owners.set(key, list);
    };

    for (const module of modules.values()) {
        for (const item of module.classes) {
            add(item.name, module.name);
        }

        for (const item of module.procedures) {
            add(item.name, module.name);
        }

        for (const item of module.constants) {
            add(item.name, module.name);
        }
    }

    return owners;
}

/** Записать обратный указатель; true, если файл изменился. */
function writeSymbolOwners(modules) {
    const owners = buildSymbolOwners(modules);
    const symbols = {};

    for (const key of [...owners.keys()].sort()) {
        symbols[key] = [...owners.get(key)]
            .sort((left, right) => left.localeCompare(right));
    }

    const payload = `${JSON.stringify(
        { version: SYMBOLS_VERSION, symbols },
        null,
        1
    )}\n`;
    let previous = "";

    try {
        previous = fs.readFileSync(SYMBOLS_FILE, "utf8");
    } catch (_error) { /* файла ещё нет: это обычное состояние */ }

    if (previous === payload) {
        return false;
    }

    fs.writeFileSync(SYMBOLS_FILE, payload, "utf8");

    return true;
}

function main() {
    const fix = process.argv.includes("--fix");
    const { index, modules } = readCatalog();
    const owners = buildClassOwners(modules);

    if (fix) {
        const changed = fixDependencies(index, modules, owners);
        console.log(changed
            ? "index.json: зависимости досчитаны"
            : "index.json: зависимости уже полны");
        console.log(writeSymbolOwners(modules)
            ? "symbols.json: обратный указатель записан"
            : "symbols.json: обратный указатель уже актуален");
    }

    const standard = standardLibraryClasses();
    const { problems } = collectProblems(modules, owners, standard);
    const byKind = new Map();

    for (const problem of problems) {
        const list = byKind.get(problem.kind) || [];
        list.push(problem);
        byKind.set(problem.kind, list);
    }

    for (const [kind, list] of byKind) {
        console.log(`\n${kind}: ${list.length}`);
        for (const problem of list.slice(0, 20)) {
            console.log(`  ${problem.module}: ${problem.detail}`);
        }
        if (list.length > 20) {
            console.log(`  ... ещё ${list.length - 20}`);
        }
    }

    const blocking = problems.filter(problem =>
        problem.kind === "missing-base-class" ||
        problem.kind === "inheritance-cycle" ||
        problem.kind === "undeclared-dependency" ||
        problem.kind === "undeclared-type-dependency" ||
        problem.kind === "duplicates-standard-class"
    );

    console.log(
        `\nВсего: ${problems.length}, из них блокирующих: ${blocking.length}`
    );
    process.exitCode = blocking.length > 0 && !fix ? 1 : 0;
}

module.exports = {
    readCatalog,
    buildClassOwners,
    collectProblems,
    dependencyClosure,
    standardLibraryClasses
};

if (require.main === module) {
    main();
}
