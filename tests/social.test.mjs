import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*)<\/script>/)[1];

/* the pure helpers, lifted out and run on their own */
const helpers = src.slice(src.indexOf('function platformPostIdOf(url)'),
                          src.indexOf('/* ---- linking ---'));
const ctx = vm.createContext({ String, Math });
vm.runInContext(helpers +
  '\nthis.platformPostIdOf = platformPostIdOf; this.platformOfUrl = platformOfUrl;' +
  '\nthis.hashtagsIn = hashtagsIn; this.mentionsIn = mentionsIn;' +
  '\nthis.socialEngagements = socialEngagements;' +
  '\nthis.socialEngagementRate = socialEngagementRate; this.socialViewRatio = socialViewRatio;', ctx);
const { platformPostIdOf, platformOfUrl, hashtagsIn, mentionsIn,
        socialEngagements, socialEngagementRate, socialViewRatio } = ctx;

/* ---- identifying a post ------------------------------------------------ */

test('an Instagram reel, post and tv link all yield a stable id', () => {
  assert.equal(platformPostIdOf('https://www.instagram.com/reel/Cx1_ab-cD/'), 'ig_Cx1_ab-cD');
  assert.equal(platformPostIdOf('https://instagram.com/p/Cx1_ab-cD'), 'ig_Cx1_ab-cD');
  assert.equal(platformPostIdOf('https://www.instagram.com/reels/Cx1_ab-cD/?igsh=xyz'), 'ig_Cx1_ab-cD');
});

test('the same post with tracking junk on the end is the same post', () => {
  const a = platformPostIdOf('https://www.instagram.com/reel/ABC123/');
  const b = platformPostIdOf('https://www.instagram.com/reel/ABC123/?igshid=99&utm_source=x');
  assert.equal(a, b);
});

test('a TikTok video id is read out of the path', () => {
  assert.equal(platformPostIdOf('https://www.tiktok.com/@someone/video/7301234567890123456'),
    'tt_7301234567890123456');
});

test('an unrecognised link still gets an id, minus the query string', () => {
  assert.equal(platformPostIdOf('https://example.com/watch/9?ref=a#t=3'), 'https://example.com/watch/9');
  assert.equal(platformPostIdOf(''), '');
  assert.equal(platformPostIdOf(null), '');
});

test('the platform is read off the link, not assumed from the creator', () => {
  /* a creator recorded as an Instagram creator who posts a TikTok must not
     have that video filed under Instagram */
  assert.equal(platformOfUrl('https://www.tiktok.com/@x/video/7', 'Instagram'), 'TikTok');
  assert.equal(platformOfUrl('https://www.instagram.com/reel/A/', 'TikTok'), 'Instagram');
  assert.equal(platformOfUrl('https://youtu.be/abc', 'Instagram'), 'YouTube');
  assert.equal(platformOfUrl('', 'TikTok'), 'TikTok', 'falls back when there is no link');
});

/* ---- captions ---------------------------------------------------------- */

test('hashtags come out lowercased, Korean and Japanese included', () => {
  assert.deepEqual([...hashtagsIn('Great meal #Vively #스시코지 #寿司 x')], ['#vively', '#스시코지', '#寿司']);
});

test('a caption with no hashtags gives an empty list, not a list with an empty string', () => {
  assert.deepEqual([...hashtagsIn('no tags here')], []);
  assert.deepEqual([...hashtagsIn('')], []);
  assert.deepEqual([...hashtagsIn(null)], []);
});

test('mentions are picked up separately from hashtags', () => {
  assert.deepEqual([...mentionsIn('thanks @sushikoji.jp and @vively_global')], ['@sushikoji.jp', '@vively_global']);
});

/* ---- the derived figures ----------------------------------------------- */

test('engagements are the four counts added up', () => {
  assert.equal(socialEngagements({ likes: 10, comments: 4, shares: 3, saves: 2 }), 19);
  assert.equal(socialEngagements({ likes: 10 }), 10, 'missing counts are zero, not NaN');
  assert.equal(socialEngagements(null), 0);
});

test('engagement rate is against views', () => {
  assert.equal(socialEngagementRate({ views: 1000, likes: 50, comments: 25, shares: 15, saves: 10 }), 10);
});

test('a post with no views has no rate, rather than a rate of zero', () => {
  /* zero would sort an unmeasured post in with genuinely bad ones, and
     would drag the average down as though it had really underperformed */
  assert.equal(socialEngagementRate({ views: 0, likes: 40 }), null);
  assert.equal(socialEngagementRate({ likes: 40 }), null);
  assert.equal(socialEngagementRate(null), null);
});

test('views per follower needs both numbers', () => {
  assert.equal(socialViewRatio({ views: 9000 }, { followers: 3000 }), 3);
  assert.equal(socialViewRatio({ views: 9000 }, { followers: 0 }), null);
  assert.equal(socialViewRatio({ views: 0 }, { followers: 3000 }), null);
  assert.equal(socialViewRatio({ views: 9000 }, null), null);
});

/* ---- the storage split, asserted on the source ------------------------- */

const payloadSrc = src.slice(src.indexOf('function dbPayload()'),
                             src.indexOf('function dbPayload()') + 600);

test('the saved shape strips content off the rows', () => {
  assert.ok(/const \{ content, \.\.\.rest \} = p;/.test(payloadSrc),
    'a participant must not be serialised with its content, or the post is stored twice');
  assert.ok(/socialContent: DB\.socialContent/.test(payloadSrc),
    'the library must be part of what gets saved');
});

test('every load path re-links the rows to the library', () => {
  /* four of them: the server, local storage, a restored backup, and the
     adoption of a workspace saved before the split existed */
  const calls = (src.match(/\blinkSocialContent\(\)/g) || []).length;
  assert.ok(calls >= 4, `only ${calls} load path(s) re-link — one of them will show rows with no content`);
});

test('a content record is only ever created in one place', () => {
  /* it used to be built as an object literal in four places, which is how
     three of them ended up missing fields the fourth had */
  const literals = (src.match(/reach: 0, profileVisits: 0, followsGained: 0, linkClicks: 0,/g) || []).length;
  assert.equal(literals, 1, 'the content shape should be defined once, in socialContentDefaults');
});
