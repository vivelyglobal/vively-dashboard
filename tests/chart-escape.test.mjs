/* A campaign brand comes from a Notion page title (server/notion-autocreate.js
   stores it untrusted), and the analytics charts use it as a bar / segment
   label that is put into innerHTML. These tests feed a hostile label to the
   real src/charts/index.js and check nothing survives as markup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeEl(tag) {
  const el = {
    tag, style: {}, children: [], className: '', title: '', _html: '', textContent: '',
    classList: { add() {}, remove() {} },
    appendChild(c) { el.children.push(c); return c; },
    setAttribute() {}, addEventListener() {}
  };
  Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el._html = String(v); } });
  return el;
}
globalThis.window = globalThis.window || globalThis;
globalThis.document = { createElement: fakeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };

const { barsH, splitBar } = await import('../src/charts/index.js');

const HOSTILE = '<img src=x onerror=alert(1)>" onmouseover="alert(2)';
const allHtml = (el) => [el._html].concat(el.children.flatMap(allHtml)).join('\n');

test('bar chart: a hostile label is escaped in the row, in the title attribute and in the table fallback', () => {
  const mount = fakeEl('div');
  barsH(mount, [{ label: HOSTILE, value: 5 }, { label: 'Aura Seoul', value: 3 }], {});
  const html = allHtml(mount);
  assert.ok(!/<img/i.test(html), 'no tag from the label survives');
  assert.ok(!/title="[^"]*"\s*onmouseover/i.test(html), 'the quote cannot close the title attribute');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot; onmouseover=&quot;alert(2)'));
  assert.ok(html.includes('Aura Seoul'));
});

test('split bar: a hostile segment label is escaped in the legend and in the table fallback', () => {
  const mount = fakeEl('div');
  splitBar(mount, [{ label: HOSTILE, value: 5, color: 'red' }, { label: 'Other', value: 5, color: 'blue' }], {});
  const html = allHtml(mount);
  assert.ok(!/<img/i.test(html));
  assert.ok(html.includes('&lt;img'));
});
