import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagesToMd } from '../src/pack/formats/pdf-layout.js';

const styles = { sans: { fontFamily: 'sans-serif' }, mono: { fontFamily: 'monospace' }, serif: { fontFamily: 'serif' } };
// Text fragment the way pdf.js reports it: transform [size, 0, 0, size, x, y].
const t = (str, x, y, { size = 12, font = 'sans', width = str.length * size * 0.5 } = {}) => ({
  str, transform: [size, 0, 0, size, x, y], width, fontName: font,
});
const page = (items, height = 792, bottom = 0) => ({ items, styles, view: [0, bottom, 612, bottom + height] });
const md = (...pages) => pagesToMd(pages).map((p) => p.md);

test('superscript stays on its line', () => {
  const [out] = md(page([t('E = mc', 72, 700), t('2', 110, 706, { size: 8 })]));
  assert.equal(out, 'E = mc 2');
});

test('ordinary letter before a font change is not a bullet', () => {
  const [out] = md(page([t('q', 50, 700, { font: 'serif' }), t(' ', 56, 700), t('= 10', 62, 700)])); // pdf.js emits the space
  assert.equal(out, 'q = 10');
});

test('Courier "o" before body text is a sub-bullet', () => {
  const [out] = md(page([
    t('•', 35, 700), t('Architecture is:', 50, 700),
    t('o', 55, 680, { font: 'mono', width: 10 }), t('All about communication.', 72, 680),
  ]));
  assert.equal(out, '- Architecture is:\n  - All about communication.');
});

test('Word "o" sub-bullet followed by a tab gap is a bullet', () => {
  const [out] = md(page([t('o', 126, 305, { size: 10, width: 6 }), t('page: the current page number.', 144, 305)]));
  assert.equal(out, '- page: the current page number.');
});

test('a minus sign is not a dash bullet', () => {
  const [out] = md(page([t('-', 72, 700, { width: 4 }), t('5 °C overnight', 76, 700)]));
  assert.equal(out, '-5 °C overnight');
});

test('numbered content repeated across pages is kept', () => {
  const pages = [1, 2, 3, 4].map((n) => page([t(`Exercise ${n}`, 72, 600), t(`Compute ${n} + ${n}`, 72, 580)]));
  assert.deepEqual(md(...pages), [1, 2, 3, 4].map((n) => `Exercise ${n}\n\nCompute ${n} + ${n}`));
});

test('running footer and page number in the margin are dropped', () => {
  const pages = [1, 2, 3, 4].map((n) =>
    page([t(`Body text ${n}`, 72, 600), t('RMIT Classification: Trusted', 72, 30), t(String(n), 500, 30)]));
  assert.deepEqual(md(...pages), [1, 2, 3, 4].map((n) => `Body text ${n}`));
});

test('slide title drawn last still comes first, as a heading', () => {
  const [out] = md(page([
    t('•', 35, 400, { size: 32 }), t('The complex and carefully designed structure', 50, 400, { size: 32 }),
    t('Architecture', 36, 480, { size: 36 }),
  ], 540));
  assert.equal(out, '#### Architecture\n\n- The complex and carefully designed structure');
});

test('wrapped bullet lines are joined', () => {
  const [out] = md(page([
    t('•', 35, 400, { size: 32 }), t('first half of a long', 50, 400, { size: 32 }),
    t('sentence continues here', 50, 362, { size: 32 }), t('and ends here.', 50, 324, { size: 32 }),
  ], 540));
  assert.equal(out, '- first half of a long sentence continues here and ends here.');
});

test('monospace lines become a code block with indentation', () => {
  const [out] = md(page([
    t('Example:', 72, 700),
    t('<datalist id="x">', 72, 680, { font: 'mono', size: 10 }),
    t('<option value="a"></option>', 84, 666, { font: 'mono', size: 10 }),
    t('</datalist>', 72, 652, { font: 'mono', size: 10 }),
  ]));
  assert.equal(out, 'Example:\n\n```\n<datalist id="x">\n  <option value="a"></option>\n</datalist>\n```');
});

test('rows with wide column gaps become a table', () => {
  const [out] = md(page([
    t('Country', 72, 700), t('Partner', 300, 700),
    t('Vietnam', 72, 685), t('J&T Express', 300, 685),
    t('Ghana', 72, 670), t('Ghana Post', 300, 670),
  ]));
  assert.equal(out, '| Country | Partner |\n| --- | --- |\n| Vietnam | J&T Express |\n| Ghana | Ghana Post |');
});

test('staggered diagram labels do not chain into one line', () => {
  const [out] = md(page([
    t('End-user', 72, 400), t('Programmers', 300, 400),
    t('Functionality', 72, 391), t('Software management', 300, 391),
    t('LOGICAL VIEW', 72, 382),
  ]));
  assert.ok(!out.includes('EndFunctionality'), out);
  assert.match(out, /End-user/);
  assert.match(out, /Functionality/);
});

test('small footer above a big title stays a separate line', () => {
  const [out] = md(page([t('RMIT Classification: Trusted', 424, 526, { size: 10 }), t('We want the Product details', 36, 502, { size: 36 }), t('Body text here that is long enough to set the body size', 36, 400, { size: 20 })], 540));
  assert.ok(!out.includes('detailsRMIT') && !out.includes('details RMIT'), out);
});

test('superscript and subscript on one line both stay on it', () => {
  const [out] = md(page([t('x', 72, 700), t('2', 78, 706, { size: 8 }), t('+ y', 86, 700), t('1', 106, 697, { size: 8 })]));
  assert.equal(out, 'x2 + y 1'); // one line; the touching superscript joins without a space
});

test('margins are measured from the visible page box, not y = 0', () => {
  const pages = [1, 2, 3, 4].map((n) => page([t(`Exercise ${n}`, 72, 800), t('Body text that sets the size', 72, 760)], 792, 400));
  assert.deepEqual(md(...pages), [1, 2, 3, 4].map((n) => `Exercise ${n}\n\nBody text that sets the size`));
});

test('a big badge glyph between two label rows does not merge them', () => {
  const [out] = md(page([
    t('Customer', 123, 385, { size: 20 }), t('Order', 436, 385, { size: 20 }),
    t('1', 602, 365.8, { size: 36 }),
    t('Controller', 121, 361, { size: 20 }), t('Controller', 418, 361, { size: 20 }),
    t('A long paragraph of body text so that the body size is twenty points.', 36, 200, { size: 20 }),
  ], 540));
  assert.ok(!/Customer.*Controller/.test(out) && !/Controller.*Customer/.test(out), out);
});

test('small caps on one baseline stay one line', () => {
  const [out] = md(page([t('C', 72, 700, { size: 12, width: 8 }), t('REATE A', 80, 700, { size: 9.6 })]));
  assert.equal(out, 'CREATE A');
});

test('a short upper label next to a distant badge does not bridge rows', () => {
  const [out] = md(page([
    t('CPU', 123, 385, { size: 20 }),
    t('1', 602, 365.8, { size: 36 }),
    t('Controller', 121, 361, { size: 20 }),
    t('A long paragraph of body text so that the body size is twenty points.', 36, 200, { size: 20 }),
  ], 540));
  assert.ok(!/Controller.*CPU|CPU.*Controller/.test(out), out);
});

test('ordinary row text under a big heading is not taken as a script', () => {
  const [out] = md(page([
    t('Heading', 72, 700, { size: 36 }),
    t('This row says', 72, 690), t('CPU', 170, 690),
    t('Body paragraph text long enough to set the body font size to twelve.', 72, 600),
  ]));
  assert.ok(!out.includes('HeadingCPU') && !out.includes('Heading CPU'), out);
  assert.match(out, /This row says( \| | )CPU/); // same row (the 20pt gap reads as a column)
});

test('left-hand superscript stays with its expression', () => {
  const [out] = md(page([t('14', 72, 706, { size: 8, width: 8 }), t('C', 82, 700), t('is radioactive', 92, 700)]));
  assert.equal(out, '14 C is radioactive');
});

test('nearby superscripts each attach to their own base', () => {
  const [sup] = md(page([t('x', 72, 700), t('2', 78, 706, { size: 8, width: 4 }), t('+y', 82, 700), t('2', 94, 706, { size: 8, width: 4 })]));
  assert.equal(sup, 'x2+y2');
  const [sub] = md(page([t('x', 72, 700), t('1', 78, 696, { size: 8, width: 4 }), t('+y', 82, 700), t('2', 94, 696, { size: 8, width: 4 })]));
  assert.equal(sub, 'x1+y2');
});

test('stacked subscript and superscript share their base', () => {
  const eol = { str: '', hasEOL: true, transform: [8, 0, 0, 8, 78, 696], width: 0, fontName: 'sans' };
  const [out] = md(page([t('x', 72, 700), t('i', 78, 696, { size: 8, width: 3 }), eol, t('j', 78, 706, { size: 8, width: 3 })]));
  assert.match(out, /^x(ij|ji)$/); // one line; stacked scripts share an x, so their order is arbitrary
});

test('a lower-case line after an unfinished sentence continues it, even with loose slide spacing', () => {
  const [out] = md(page([
    t('Body text on this slide sets the body size for the whole page here.', 50, 500, { size: 20 }),
    t('I cannot attend any', 50, 440, { size: 20 }), t('consultance meeting. Plus, I am busy.', 50, 395, { size: 20 }),
  ], 540));
  assert.equal(out, 'Body text on this slide sets the body size for the whole page here.\n\nI cannot attend any consultance meeting. Plus, I am busy.');
});

test('a larger lower-case line is not a heading', () => {
  const [out] = md(page([
    t('•', 35, 400, { size: 20 }), t('Business acquaintances are not as', 50, 400, { size: 20 }),
    t('understanding or forgiving', 50, 370, { size: 24 }),
    t('A long paragraph of body text so that the body size is twenty points.', 36, 200, { size: 20 }),
  ], 540));
  assert.match(out, /^- Business acquaintances are not as understanding or forgiving$/m);
});

test('heading lines that merge into a long sentence become a paragraph', () => {
  const [out] = md(page([
    t("Society's expected behaviours that should be used", 50, 400, { size: 24 }),
    t('when writing or answering email messages.', 50, 372, { size: 24 }),
    t('A long paragraph of body text so that the body size is twenty points.', 36, 200, { size: 20 }),
    t('And a second long line of body text, also at twenty points, to be sure.', 36, 176, { size: 20 }),
  ], 540));
  assert.equal(out.split('\n')[0], "Society's expected behaviours that should be used when writing or answering email messages.");
});

test('a slide title wrapped onto a lower-case second line stays one heading', () => {
  const [out] = md(page([
    t('Message-oriented persistent', 36, 480, { size: 36 }), t('asynchronous communication', 36, 440, { size: 36 }),
    t('•', 35, 300, { size: 24 }), t('MOM: message-oriented middleware stores messages in queues', 50, 300, { size: 24 }),
    t('•', 35, 260, { size: 24 }), t('Applications communicate by inserting messages in queues', 50, 260, { size: 24 }),
  ], 540));
  assert.match(out, /^#### Message-oriented persistent asynchronous communication$/m);
});

test('large text whose sentence goes on in body text is a paragraph', () => {
  const [out] = md(page([
    t('Careers staff emailed this student', 50, 400, { size: 28 }),
    t('to offer a CV consultation and here is the reply he wrote back.', 50, 370, { size: 20 }),
    t('A long paragraph of body text so that the body size is twenty points.', 36, 200, { size: 20 }),
    t('And a second long line of body text, also at twenty points, to be sure.', 36, 176, { size: 20 }),
  ], 540));
  assert.equal(out.split('\n')[0], 'Careers staff emailed this student to offer a CV consultation and here is the reply he wrote back.');
});
