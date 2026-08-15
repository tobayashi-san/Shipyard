import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

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
          /[ÄÖÜäöüß]/.test(source)
            ? [`${path.replace(`${sourceRoot}/`, "")}: German character`]
            : [],
        );
    });

    expect(violations).toEqual([]);
  });
});
