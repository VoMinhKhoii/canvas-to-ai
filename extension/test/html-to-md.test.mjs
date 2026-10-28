import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, parseHTML } from 'linkedom';

// The converter runs in the browser; give Node the DOM globals it uses.
// Browsers wrap an HTML fragment in <html><body>; linkedom needs it spelled out.
globalThis.DOMParser = class extends DOMParser {
  parseFromString(html, type) {
    return super.parseFromString(`<!doctype html><html><body>${html}</body></html>`, type);
  }
};
globalThis.Node = parseHTML('<html></html>').Node;
const { htmlToMd } = await import('../src/html-to-md.js');

test('headings keep literal characters', () => {
  assert.equal(htmlToMd('<h1>__init__ and 2 ** 3</h1>'), '#### __init__ and 2 ** 3');
});

test('bold inside headings is not marked up', () => {
  assert.equal(htmlToMd('<h2><strong>HTML5 tags</strong></h2>'), '##### HTML5 tags');
});

test('images inside headings are kept', () => {
  const md = htmlToMd('<h2>Diagram<img src="/courses/1/files/123"></h2>', () => '![](images/123-d.png)');
  assert.equal(md, '##### Diagram\n\n![](images/123-d.png)');
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
