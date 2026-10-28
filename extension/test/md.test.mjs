import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdTable, contentHeading } from '../src/md.js';

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
