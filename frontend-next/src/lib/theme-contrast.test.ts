import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_PRESETS } from "./store";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

type Tokens = Record<string, string>;

function tokensFrom(body: string): Tokens {
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+)/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function block(pattern: RegExp): Tokens {
  const match = css.match(pattern);
  if (!match) throw new Error(`Theme block not found: ${pattern}`);
  return tokensFrom(match[1]);
}

const lightBase = block(/:root\s*\{([\s\S]*?)\n\s*\}/);
const darkBase = { ...lightBase, ...block(/\.dark\s*\{([\s\S]*?)\n\s*\}/) };
const sharedLightStatus = block(
  /:root:not\(\.dark\)\[data-console-theme\]\s*\{([\s\S]*?)\n\s*\}/,
);
const sharedDarkStatus = block(
  /:root\.dark\[data-console-theme\]\s*\{([\s\S]*?)\n\s*\}/,
);

const presets = [...css.matchAll(/:root(\.dark)?\[data-console-theme='([^']+)'\]\s*\{([\s\S]*?)\n\s*\}/g)].map(
  ([, dark, name, body]) => ({
    name,
    tokens: {
      ...(dark ? darkBase : lightBase),
      ...tokensFrom(body),
      ...(dark ? sharedDarkStatus : sharedLightStatus),
    },
  }),
);

function hslToRgb(value: string): [number, number, number] {
  const [h, saturation, lightness] = value.split(/\s+/).map(Number.parseFloat);
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const offset = l - chroma / 2;
  const [r, g, b] =
    h < 60 ? [chroma, x, 0]
    : h < 120 ? [x, chroma, 0]
    : h < 180 ? [0, chroma, x]
    : h < 240 ? [0, x, chroma]
    : h < 300 ? [x, 0, chroma]
    : [chroma, 0, x];
  return [r + offset, g + offset, b + offset];
}

function luminance(value: string): number {
  return hslToRgb(value)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index],
      0,
    );
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("console theme contrast", () => {
  it("defines every expected theme preset", () => {
    expect(presets.map((preset) => preset.name).sort()).toEqual(
      THEME_PRESETS.map((preset) => preset.id).sort(),
    );
  });

  for (const { name, tokens } of presets) {
    it(`${name} meets WCAG contrast targets`, () => {
      const textPairs: Array<[string, string]> = [
        ["foreground", "background"],
        ["card-foreground", "card"],
        ["popover-foreground", "popover"],
        ["primary-foreground", "primary"],
        ["secondary-foreground", "secondary"],
        ["muted-foreground", "background"],
        ["accent-foreground", "accent"],
        ["destructive-foreground", "destructive"],
        ["success", "background"],
        ["warning", "background"],
        ["info", "background"],
        ["destructive", "background"],
      ];

      for (const [foreground, background] of textPairs) {
        expect(
          contrast(tokens[foreground], tokens[background]),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      expect(contrast(tokens.ring, tokens.background), "focus ring").toBeGreaterThanOrEqual(3);
    });
  }
});
