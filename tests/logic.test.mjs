import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guessNotionField, notionVisitValue, parseVisitSlot, notionMetricValue,
         applyNotionContent, NOTION_FIELD_DEFS } from '../src/import/notion.js';
import { parseFollowers, handleFromUrl, normHeader, countryOf } from '../src/import/excel.js';
import { guessMetricColumn, handleFromCell } from '../src/import/metrics.js';
import { dayKey } from '../src/model/calendar.js';

/* --- Notion column mapping -------------------------------------------------
   The two collisions that cost a full sync round earlier: "Email Address"
   contains "address", and "Instagram Follower" contains "instagram". */
test('column names map to the field a human would pick', () => {
  assert.equal(guessNotionField('Email Address', 'email'), 'email');
  assert.equal(guessNotionField('Instagram Follower', 'number'), 'followers');
  assert.equal(guessNotionField('Instagram', 'url'), 'instagram');
  assert.equal(guessNotionField('Comments', 'number'), 'comments');
  assert.equal(guessNotionField('Views', 'number'), 'views');
  assert.equal(guessNotionField('Likes', 'number'), 'likes');
  assert.equal(guessNotionField('Shares', 'number'), 'shares');
  assert.equal(guessNotionField('Metrics Updated', 'date'), 'metricsAt');
  assert.equal(guessNotionField('Date & Time Availability', 'date'), 'visitAt');
  assert.equal(guessNotionField('Message', 'rich_text'), 'note');
});

test('Notion bookkeeping columns are not mistaken for a booking', () => {
  ['Created time', 'Last edited time', 'Submitted at'].forEach((h) => {
    assert.notEqual(guessNotionField(h, 'date'), 'visitAt', h);
  });
});

test('every field definition has a key and a label', () => {
  NOTION_FIELD_DEFS.forEach((d) => {
    assert.ok(d.key && d.label, JSON.stringify(d));
  });
});

/* --- booking times ---------------------------------------------------------
   7pm at the Jongno counter is 7pm wherever the dashboard is opened from. */
test('a booking keeps its wall-clock time regardless of the reader timezone', () => {
  assert.equal(notionVisitValue('2026-09-04T19:00:00.000+09:00'), '2026-09-04 19:00');
  assert.equal(notionVisitValue('2026-09-04'), '2026-09-04');
  assert.equal(notionVisitValue(''), '');
});

test('a slot parses back to the same wall-clock time', () => {
  const d = parseVisitSlot('2026-09-04 19:00');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 4);
  assert.equal(d.getHours(), 19);
  assert.equal(dayKey(d), '2026-09-04');
  assert.equal(parseVisitSlot('not a date'), null);
});

/* --- performance numbers ---------------------------------------------------
   parseFollowers reads a bare 45 as 45,000, which is right for a follower
   count typed as "45k" and very wrong for 45 comments. */
test('metric values are read literally, follower counts are not', () => {
  assert.equal(notionMetricValue(45), 45);
  assert.equal(notionMetricValue('45'), 45);
  assert.equal(notionMetricValue('12,540'), 12540);
  assert.equal(notionMetricValue('1.2만'), 12000);
  assert.equal(notionMetricValue('3.4k'), 3400);
  assert.equal(notionMetricValue('Hidden'), null);
  assert.equal(notionMetricValue(''), null);
  assert.equal(notionMetricValue(null), null);
  assert.equal(parseFollowers('45').value, 45000);
});

test('performance numbers land on the participant content record', () => {
  const p = {};
  const cr = { handle: '@test' };
  const ap = { contentUrl: 'https://instagram.com/reel/abc', platform: 'Instagram',
               metrics: { views: 1000, likes: 20, comments: 3, shares: 1 },
               metricsAt: '2026-08-25' };
  const touched = applyNotionContent(p, ap, cr);
  assert.ok(touched > 0);
  assert.equal(p.content.url, ap.contentUrl);
  assert.equal(p.content.views, 1000);
  assert.equal(p.content.likes, 20);
  assert.equal(p.content.metricsAt, '2026-08-25');
  /* re-applying identical numbers is a no-op, so a repeat sync reports nothing */
  assert.equal(applyNotionContent(p, ap, cr), 0);
});

test('a row with neither a link nor numbers leaves content alone', () => {
  const p = {};
  assert.equal(applyNotionContent(p, { metrics: {} }, { handle: '@x' }), 0);
  assert.equal(p.content, undefined);
});

/* --- spreadsheet columns --------------------------------------------------- */
test('spreadsheet headers map to the metric they name', () => {
  assert.equal(guessMetricColumn('Views (plays)'), 'views');
  assert.equal(guessMetricColumn('Likes'), 'likes');
  assert.equal(guessMetricColumn('Comments'), 'comments');
  assert.equal(guessMetricColumn('Reposts (shares)'), 'shares');
  assert.equal(guessMetricColumn('Post URL'), 'url');
  assert.equal(guessMetricColumn('Profile (handle)'), 'handle');
});

test('handles arrive in every shape and normalise to one', () => {
  assert.equal(handleFromCell('@julia.glowwy'), '@julia.glowwy');
  assert.equal(handleFromCell('julia.glowwy'), '@julia.glowwy');
  assert.equal(handleFromUrl('https://www.instagram.com/julia.glowwy/', 'Instagram').handle, '@julia.glowwy');
  assert.equal(normHeader('Post  URL'), 'post url');
});

test('nationalities resolve to the country the roster groups by', () => {
  assert.equal(countryOf('Korean'), 'Korea');
  assert.equal(countryOf('Vietnamese'), 'Vietnam');
});

/* --- a quirk that was recorded, then fixed ---------------------------------
   The alias table matches on substrings, and "no" is the alias for the
   row-number column, so a column named exactly "Note" or "Notes" used to be
   read as a row number and never synced. That stopped being cosmetic once
   Notes became a column a partner reads. */
test('a column named "Notes" is the creator\'s note, not a row number', () => {
  assert.equal(guessNotionField('Notes', 'rich_text'), 'formNotes');
  assert.equal(guessNotionField('Note', 'rich_text'), 'formNotes');
  assert.equal(guessNotionField('비고', 'rich_text'), 'formNotes');
});

test('Notion bookkeeping columns are not read as a booking slot', () => {
  /* both of these were being read as the visit slot, which would have set
     every creator's booking to the moment they filled the form */
  assert.equal(guessNotionField('Submission time', 'created_time'), 'skip');
  assert.equal(guessNotionField('Posted Date', 'date'), 'skip');
  assert.equal(guessNotionField('Number of people visiting ', 'rich_text'), 'skip');
});

test('the columns added for the partner view map correctly', () => {
  assert.equal(guessNotionField('성별', 'select'), 'gender');
  assert.equal(guessNotionField('Gender', 'select'), 'gender');
  assert.equal(guessNotionField('Accepted/Rejected Message', 'formula'), 'acceptMessage');
});
