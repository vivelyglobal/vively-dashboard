import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* The rule the sync uses to decide whether a Notion answer replaces what is
   already here. It used to be "ap.x || p.x", which keeps the old value
   whenever the new one is empty — so a field cleared in Notion stayed filled
   in the dashboard forever, and the roster looked stuck. Pulled out of the
   real index.html so this tests the shipping rule. */
const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*)<\/script>/)[1];
const from = src.indexOf('      const mapped = new Set(');
const to = src.indexOf('p.remark = merge(', from);
const body = src.slice(from, src.indexOf('\n', to));

const run = (mapping, ap, current) => {
  const ctx = vm.createContext({ Object, Set, cp: { notionMapping: mapping }, ap, p: { ...current } });
  vm.runInContext(body + '\nthis.out = p;', ctx);
  return ctx.out;
};

test('a mapped column that now has a value replaces the old one', () => {
  const out = run({ 'Remark': 'remark' }, { remark: '2명 방문' }, { remark: '1명 방문' });
  assert.equal(out.remark, '2명 방문');
});

test('a mapped column that has been CLEARED clears it here too', () => {
  /* the bug: this used to keep "1명 방문" forever */
  const out = run({ 'Remark': 'remark' }, { remark: '' }, { remark: '1명 방문' });
  assert.equal(out.remark, '');
});

test('a field with no column mapped to it is left alone', () => {
  /* nothing in this form asks about remark, so Notion has no opinion and
     a remark typed in the dashboard must survive */
  const out = run({ 'Notes': 'formNotes' }, { remark: '', formNotes: '' }, { remark: 'typed by hand' });
  assert.equal(out.remark, 'typed by hand');
});

test('a column mapped to skip does not count as mapped', () => {
  const out = run({ 'Remark': 'skip' }, { remark: '' }, { remark: 'typed by hand' });
  assert.equal(out.remark, 'typed by hand');
});

test('every synced field follows the same rule', () => {
  const mapping = { a: 'fullName', b: 'address', c: 'contact', d: 'nationality',
                    e: 'otherSns', f: 'formNotes', g: 'remark' };
  const cleared = { fullName: '', address: '', contact: '', nationality: '',
                    otherSns: '', formNotes: '', remark: '' };
  const had = { fullName: 'x', address: 'x', contact: 'x', nationality: 'x',
                otherSns: 'x', formNotes: 'x', remark: 'x' };
  const out = run(mapping, cleared, had);
  Object.keys(had).forEach((k) => assert.equal(out[k], '', k + ' stayed stuck'));
});
