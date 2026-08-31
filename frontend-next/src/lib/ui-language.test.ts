import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const sourceRoot = new URL("..", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (![".ts", ".tsx", ".json"].includes(extname(entry.name))) return [];
    return entry.name.endsWith(".test.ts") ? [] : [path];
  });
}

const germanUiTerms = [
  "Adressraum",
  "Verwendbare",
  "Einzeladressen",
  "Netzwerkkonfiguration",
  "Rolle",
  "Freigegebener",
  "Betriebsstatus",
  "unbekannt",
  "Systeme",
  "Plattform",
  "Lauf",
  "Bereit",
  "Aktiv",
  "Inaktiv",
  "Aktion",
  "Aufgabe",
  "Zugriff",
  "Gespeicherter",
  "Erneut versuchen",
  "Adressinventar",
  "Definitionen",
  "verwalten",
  "Typ",
  "Zugewiesen",
  "Aufgabenhistorie",
  "Plattformbereiche",
  "Aktivieren",
  "Zeitpunkt",
  "Beobachtet",
  "Grund",
  "Zugang",
  "entfernen",
  "Zuletzt",
  "Verwaltungsmodus",
];

const legacyObjectTerms = [
  "Shipyard host",
  "Manage hosts",
  "Manage platforms",
  "Networks & IPAM",
  "Playbook workflows",
  "Servers — agent status",
];

function containsTerm(source: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(source);
}

describe("UI language consistency", () => {
  it("keeps TypeScript UI copy in English", () => {
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return germanUiTerms
        .filter((term) => containsTerm(source, term))
        .map((term) => `${path.replace(`${sourceRoot}/`, "")}: ${term}`)
        .concat(
          legacyObjectTerms
            .filter((term) => source.includes(term))
            .map((term) => `${path.replace(`${sourceRoot}/`, "")}: legacy term ${term}`),
        )
        .concat(
          /[ÄÖÜäöüß]/.test(source)
            ? [`${path.replace(`${sourceRoot}/`, "")}: German character`]
            : [],
        );
    });

    expect(violations).toEqual([]);
  });

  it("routes IPAM interface copy through the translation catalog", () => {
    const files = [
      join(sourceRoot, "routes/networks.tsx"),
      join(sourceRoot, "routes/network-detail.tsx"),
      join(sourceRoot, "routes/ipam-sources.tsx"),
    ];
    const copyAttributes = new Set([
      "title", "placeholder", "aria-label", "confirmLabel", "cancelLabel",
      "description", "label",
    ]);
    const violations: string[] = [];

    for (const path of files) {
      const source = readFileSync(path, "utf8");
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const value = node.text.replace(/\s+/g, " ").trim();
          if (/[A-Za-z]/.test(value)) {
            const line = file.getLineAndCharacterOfPosition(node.pos).line + 1;
            violations.push(`${path.replace(`${sourceRoot}/`, "")}:${line}: ${value}`);
          }
        }
        if (
          ts.isJsxAttribute(node)
          && copyAttributes.has(node.name.getText(file))
          && node.initializer
          && ts.isStringLiteral(node.initializer)
          && /[A-Za-z]/.test(node.initializer.text)
        ) {
          const line = file.getLineAndCharacterOfPosition(node.pos).line + 1;
          violations.push(`${path.replace(`${sourceRoot}/`, "")}:${line}: ${node.initializer.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }

    expect(violations).toEqual([]);
  });

  it("keeps deployment and operations keyboard shortcuts distinct", () => {
    const source = readFileSync(
      join(sourceRoot, "components/CommandPalette.tsx"),
      "utf8",
    );

    expect(source).toContain("e.key === 'e' && openTofuAvailable");
    expect(source).toContain("e.key === 'o' && canViewOperations");
    expect(source).toContain('shortcut="g e"');
    expect(source).toContain('shortcut="g o"');
  });
});
