import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageName, pathAllocator } from '../src/pack/names.js';

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

test('one download run never gives two different things the same path', async () => {
  const place = pathAllocator();
  assert.equal(place('W1', 'notes (2).txt', 'file:1'), 'W1/notes (2).txt');
  assert.equal(place('W1', 'notes.txt', 'file:2'), 'W1/notes.txt');
  assert.equal(place('W1', 'notes.txt', 'file:3'), 'W1/notes (3).txt'); // (2) is file 1's
  assert.equal(place('W1', 'notes.txt', 'file:3'), null); // already saved there
  assert.equal(place('W1', 'Lecture.md', 'page:a'), 'W1/Lecture.md');
  assert.equal(place('W1', 'Lecture.md', 'page:b'), 'W1/Lecture (2).md');
  assert.equal(place('W2', 'notes.txt', 'file:3'), 'W2/notes.txt'); // another folder
  assert.equal(place('W1', 'README', 'file:9'), 'W1/README');
  assert.equal(place('W1', 'README', 'file:8'), 'W1/README (2)');
});
