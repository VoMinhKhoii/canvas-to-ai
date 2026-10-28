import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageName } from '../src/pack/names.js';

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

test('long names are cut to 100 characters, keeping the file name and staying distinct', () => {
  const deep = (dir) => `7/${dir}/${'chapter-'.repeat(30)}/images/figure-3.png`;
  const a = imageName(deep('part-one'));
  assert.ok(a.length <= 100, String(a.length));
  assert.match(a, /images_figure-3-[a-z0-9]+\.png$/);
  assert.notEqual(a, imageName(deep('part-two')));
  assert.ok(imageName(`7/v1.2/${'x'.repeat(200)}`).length <= 100); // a dot that isn't an extension
});
