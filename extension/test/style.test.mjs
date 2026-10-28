// The panel's type and spacing budget: at most 3 font sizes, 3 font weights,
// 2 text colours and 3 spacing steps (padding, margin, gap), read from the
// stylesheet with its custom properties resolved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/panel/sidepanel.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Custom properties per theme: dark is the base :root, light overrides it.
const props = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const lightBlock = /@media \(prefers-color-scheme: light\)\s*\{([\s\S]*?\})\s*\}/.exec(css)?.[1] ?? '';
const rules = css.replace(lightBlock, '');
const themes = { dark: props(/:root\s*\{([^}]*)\}/.exec(rules)[1]) };
themes.light = { ...themes.dark, ...props(lightBlock) };
const resolver = (vars) => (value) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolver(vars)(vars[name] ?? name));
const resolve = resolver(themes.dark);
const declarations = (prop, r = resolve) => [...rules.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'g'))].map((m) => r(m[1].trim()));

// The root `font` shorthand: "<weight> <size> / <line-height> <family>".
const [rootWeight, rootSize] = resolve(/[;{\s]font\s*:\s*([^;]+);/.exec(rules)[1]).split(/\s+/);

test('at most 3 font sizes', () => {
  const sizes = new Set([rootSize, ...declarations('font-size')]);
  assert.ok(sizes.size <= 3, [...sizes].join(', '));
});

test('at most 3 font weights', () => {
  const weights = new Set([rootWeight, ...declarations('font-weight')]);
  assert.ok(weights.size <= 3, [...weights].join(', '));
});

test('at most 2 text colours in each theme', () => {
  for (const [theme, vars] of Object.entries(themes)) {
    const colours = new Set(declarations('color', resolver(vars)).filter((c) => !['inherit', 'currentColor'].includes(c)));
    assert.ok(colours.size <= 2, `${theme}: ${[...colours].join(', ')}`);
  }
  assert.notEqual(themes.dark['--text'], themes.light['--text']);
});

test('at most 3 spacing steps', () => {
  const spacing = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'row-gap', 'column-gap'];
  const steps = new Set(spacing.flatMap((prop) => declarations(prop)).flatMap((v) => v.split(/\s+/)).filter((v) => !['0', 'auto'].includes(v)));
  assert.ok(steps.size <= 3, [...steps].join(', '));
});
