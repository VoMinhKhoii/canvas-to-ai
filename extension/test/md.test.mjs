import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdTable, contentHeading, codeTags } from '../src/md.js';

test('table with a pipe inside a cell keeps its column count', () => {
  assert.equal(mdTable([['A | B', 'Result'], ['1', '2']]), '| A \\| B | Result |\n| --- | --- |\n| 1 | 2 |');
});

test('ragged rows are padded so the header matches the separator', () => {
  assert.equal(mdTable([['a'], ['b', 'c']]), '| a |  |\n| --- | --- |\n| b | c |');
});

test('content headings sit below the ### file heading, capped at ######', () => {
  assert.equal(contentHeading(1, 'T'), '#### T');
  assert.equal(contentHeading(5, 'T'), '###### T');
});

test('tag-like text outside code is wrapped in backticks', () => {
  assert.equal(codeTags('New elements like <header>, <footer> and </section>.'), 'New elements like `<header>`, `<footer>` and `</section>`.');
  assert.equal(codeTags('Use List<Employee> here'), 'Use List`<Employee>` here');
  assert.equal(codeTags('<input list="x" id="y" />'), '`<input list="x" id="y" />`');
});

test('code, comparisons and image references are left alone', () => {
  const md = '```\n<div>\n```\nAlready `<b>` coded; 3 < 4 > 2; ![](images/1-a.png)';
  assert.equal(codeTags(md), md);
});
