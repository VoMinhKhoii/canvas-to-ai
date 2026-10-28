import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/dom.mjs';

const { htmlToMd } = await import('../src/pack/formats/html-to-md.js');

test('headings keep literal characters', () => {
  assert.equal(htmlToMd('<h1>__init__ and 2 ** 3</h1>'), '#### __init__ and 2 ** 3');
});

test('highlighted code keeps its characters together', () => {
  assert.match(htmlToMd('<pre><code>a<span>&lt;</span><span>&lt;</span>1</code></pre>'), /a<<1/);
  assert.match(htmlToMd('<p>Use <code><span>x</span><span>++</span></code> here</p>'), /`x\+\+`/);
});

test('bold inside headings is not marked up', () => {
  assert.equal(htmlToMd('<h2><strong>HTML5 tags</strong></h2>'), '##### HTML5 tags');
});

test('images inside headings are kept', () => {
  const md = htmlToMd('<h2>Diagram<img src="/courses/1/files/123"></h2>', () => '![](images/123-d.png)');
  assert.equal(md, '##### Diagram\n\n![](images/123-d.png)');
});

test('images with parentheses in the name inside headings are kept whole', () => {
  const ref = '![](images/123-diagram_(1).png)'; // whatever the resolver returns is kept verbatim
  assert.equal(htmlToMd('<h2>Diagram<img src="/courses/1/files/123"></h2>', () => ref), `##### Diagram\n\n${ref}`);
});

test('Canvas module footer is removed, prose and code mentioning Previous/Next are kept', () => {
  const html = `<p>Next week we cover Kafka.</p><pre><code>Previous\nNext</code></pre>
    <a data-api-returntype="Module" href="/courses/1/modules/2"><span class="module-sequence-footer-button--previous">Previous</span></a>`;
  const md = htmlToMd(html);
  assert.match(md, /Next week we cover Kafka\./);
  assert.match(md, /```\nPrevious\nNext\n```/);
  assert.equal(md.match(/Previous/g).length, 1);
});

test('inline elements laid out apart get a space', () => {
  assert.equal(htmlToMd('<p><b>Customer Portal</b>Architecture lab</p>'), '**Customer Portal** Architecture lab');
});

test('no Markdown escaping and compact lists', () => {
  assert.equal(htmlToMd('<ol><li>1. first</li><li>file_name.txt</li></ol>'), '1. 1. first\n2. file_name.txt');
});

test('a link to a module inside a sentence keeps its text', () => {
  const html = '<p>If you are new, visit <a data-api-returntype="Module" href="/courses/1/modules/2">Getting Started</a>.</p>';
  assert.equal(htmlToMd(html), 'If you are new, visit Getting Started.');
});

test('a data table becomes a Markdown table with its caption', () => {
  const html = `<table><caption>Stay on top of key dates.</caption>
    <thead><tr><th><h3>Week</h3></th><th><h3>Activities</h3></th><th>Assessments</th></tr></thead>
    <tbody><tr><td><p>1</p></td><td><strong>Course Introduction Meeting</strong></td><td></td></tr>
    <tr><td>4</td><td></td><td>A1.1 due (30%)</td></tr></tbody></table>`;
  assert.equal(htmlToMd(html), 'Stay on top of key dates.\n\n| Week | Activities | Assessments |\n| --- | --- | --- |\n| 1 | Course Introduction Meeting |  |\n| 4 |  | A1.1 due (30%) |');
});

test('a one-column layout table keeps its content, and pictures in cells survive', () => {
  assert.equal(htmlToMd('<table><tr><td><p>Just a boxed note.</p></td></tr></table>'), 'Just a boxed note.');
  const md = htmlToMd('<table><tr><td>Diagram</td><td><img src="/courses/1/files/9"></td></tr></table>', () => '![](images/9-d.png)');
  assert.equal(md, '| Diagram |  |\n| --- | --- |\n\n![](images/9-d.png)');
});

test('horizontal rules are dropped', () => {
  assert.equal(htmlToMd('<p>One</p><hr><p>Two</p>'), 'One\n\nTwo');
});

test('paragraphs and list items inside a table cell stay apart', () => {
  const html = '<table><tr><th>Week</th><th>Activities</th></tr><tr><td>9</td><td><p>Lecture: Cache architecture</p><p>Lab: Redis</p><ul><li>SAGA</li><li>Circuit-Breaker</li></ul></td></tr></table>';
  assert.match(htmlToMd(html), /\| 9 \| Lecture: Cache architecture · Lab: Redis · SAGA · Circuit-Breaker \|/);
});
