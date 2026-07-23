"use strict";

const fs = require("fs");
const path = require("path");

const root = __dirname;
const clientPath = path.join(root, "client", "src", "extension.ts");

if (!fs.existsSync(clientPath)) {
    throw new Error(
        "Не найден client/src/extension.ts. " +
        "Распакуй архив в корень репозитория RSL-plus."
    );
}

let source = fs.readFileSync(clientPath, "utf8");
const marker = "workspace inventory is delayed";

if (!source.includes(marker)) {
    const pattern = /\s*\/\* Активный файл известен серверу до фонового обхода workspace\. \*\/\s*await notifyActiveDocument\(\);\s*const workspaceFiles = await workspace\.findFiles\(\s*"\*\*\/\*\.mac",\s*"\*\*\/\{\.git,node_modules,out\}\/\*\*"\s*\);\s*await client\.sendNotification\(\s*"workspaceFiles",\s*workspaceFiles\.map\(uri => uri\.toString\(\)\)\s*\);\s*await client\.sendNotification\("clientReady"\);/s;

    const replacement = `

            /* Активный документ получает весь интерактивный бюджет первым. */
            await notifyActiveDocument();
            await client.sendNotification("clientReady");

            /* workspace inventory is delayed: не конкурирует с первым folding/Outline. */
            setTimeout(() => {
                workspace.findFiles(
                    "**/*.mac",
                    "**/{.git,node_modules,out,dist,build,archive,backup,.history}/**"
                ).then(
                    workspaceFiles => client.sendNotification(
                        "workspaceFiles",
                        workspaceFiles.map(uri => uri.toString())
                    ),
                    error => console.error(
                        "RSL workspace inventory failed",
                        error
                    )
                );
            }, 500);`;

    const updated = source.replace(pattern, replacement);

    if (updated === source) {
        throw new Error(
            "Не найден ожидаемый блок workspace.findFiles в " +
            "client/src/extension.ts. Возможно, файл уже изменён вручную " +
            "или патч накладывается не на актуальную версию 1.1.4."
        );
    }

    source = updated;
    fs.writeFileSync(clientPath, source, "utf8");
    console.log("[OK] client/src/extension.ts обновлён");
} else {
    console.log("[OK] client/src/extension.ts уже обновлён");
}

const pathsToClean = [
    path.join(root, "server", "out"),
    path.join(root, "client", "out"),
    path.join(root, "server", "tsconfig.tsbuildinfo"),
    path.join(root, "client", "tsconfig.tsbuildinfo"),
    path.join(root, "tsconfig.tsbuildinfo")
];

for (const target of pathsToClean) {
    fs.rmSync(target, { recursive: true, force: true });
}

console.log("[OK] Старые build-артефакты удалены");
console.log("Далее выполни: npm.cmd test");
