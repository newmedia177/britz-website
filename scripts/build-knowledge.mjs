// scripts/build-knowledge.mjs
// Bündelt System-Prompt + alle knowledge/*.md in api/_bundle.mjs.
// Nach JEDER Änderung an prompts/ oder knowledge/ ausführen:
//   node scripts/build-knowledge.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const system = readFileSync("prompts/system-alex.md", "utf8").trim();

const files = readdirSync("knowledge").filter(f => f.endsWith(".md")).sort();
const knowledge = files
  .map(f => `<dokument name="${f}">\n` +
            readFileSync("knowledge/" + f, "utf8").trim() +
            `\n</dokument>`)
  .join("\n\n");

const out =
  "// AUTOMATISCH GENERIERT von scripts/build-knowledge.mjs – nicht von Hand editieren.\n" +
  "export const SYSTEM = " + JSON.stringify(system) + ";\n" +
  "export const KNOWLEDGE = " + JSON.stringify(knowledge) + ";\n";

writeFileSync("api/_bundle.mjs", out);
console.log(`ok: ${files.length} Dokumente, System ${system.length} Zeichen, ` +
            `Wissen ${knowledge.length} Zeichen -> api/_bundle.mjs`);
