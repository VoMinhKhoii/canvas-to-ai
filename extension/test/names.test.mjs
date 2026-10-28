import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageName } from '../src/names.js';

test('safe names are unchanged', () => {
  assert.equal(imageName('56375725-image19.png'), '56375725-image19.png');
});

test('cleaned names keep their extension and only use link-safe characters', () => {
  const name = imageName('123-diagram (1).png');
  assert.match(name, /^123-diagram_1_-[a-z0-9]+\.png$/);
});

test('names that clean to the same text stay distinct', () => {
  assert.notEqual(imageName('9-plot+1.png'), imageName('9-plot_1.png'));
  assert.notEqual(imageName('9-plot+1.png'), imageName('9-plot 1.png'));
});
