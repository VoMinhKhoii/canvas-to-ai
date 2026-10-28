import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelection, sectionId } from '../src/panel/selection.js';

const item = (key, extra = {}) => ({ key, kind: 'file', title: key, ...extra });
const course = {
  folders: [
    { id: 'w1', title: 'Week 1', sections: [
      { title: 'Pre-class', items: [item('a'), item('b')] },
      { title: 'Lab', items: [item('c'), item('locked', { locked: 'Locked' })] },
    ] },
    { id: 'w2', title: 'Week 2', sections: [{ title: null, items: [item('d')] }] },
  ],
};

test('picking a folder picks every unlocked item; its state follows', () => {
  const sel = createSelection(course);
  assert.equal(sel.state('w1'), 'off');
  sel.toggle('w1');
  assert.equal(sel.state('w1'), 'on');
  assert.equal(sel.count(), 3);
  assert.equal(sel.state('locked'), 'off');
  sel.toggle('w1');
  assert.equal(sel.count(), 0);
});

test('a folder with some picked is "some"; toggling it picks the rest', () => {
  const sel = createSelection(course);
  sel.toggle(sectionId(course.folders[0], 1)); // Lab
  assert.equal(sel.state('w1'), 'some');
  assert.equal(sel.state(sectionId(course.folders[0], 1)), 'on');
  sel.toggle('w1');
  assert.equal(sel.state('w1'), 'on');
});

test('picked items come back in course order with their folder and section', () => {
  const sel = createSelection(course);
  sel.toggle('d');
  sel.toggle('a');
  assert.deepEqual(sel.picked().map((p) => [p.folder.id, p.section.title, p.item.key]), [['w1', 'Pre-class', 'a'], ['w2', null, 'd']]);
});

test('locked items cannot be picked, and a node of only locked items stays off', () => {
  const sel = createSelection(course);
  sel.toggle('locked');
  assert.equal(sel.count(), 0);
  assert.equal(sel.size('w1'), 3);
});
