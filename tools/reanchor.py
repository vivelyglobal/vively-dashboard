"""Re-derives each module's line range after index.html has been edited.

Line numbers do not survive editing, so this diffs a reference copy of
index.html against the current one and maps every recorded range through
that diff. Lines inserted inside a module widen its range; lines inserted
between modules shift everything after them. Anchoring on line *text* was
tried first and is not safe here — half the boundaries are a bare "}".

    python3 tools/reanchor.py <(git show HEAD:index.html)

The reference is whatever index.html looked like when the ranges were last
correct - normally the committed copy.
"""
import difflib, json, sys

ref = open(sys.argv[1], encoding='utf-8').read().split('\n')
cur = open('index.html', encoding='utf-8').read().split('\n')
man = json.load(open('tools/manifest.json', encoding='utf-8'))

sm = difflib.SequenceMatcher(None, ref, cur, autojunk=False)
# old line index -> new line index, for lines that survived unchanged
same = {}
for a, b, n in sm.get_matching_blocks():
    for k in range(n):
        same[a + k] = b + k

def map_start(i):                     # first surviving line at or after i
    j = i
    while j < len(ref):
        if j in same: return same[j]
        j += 1
    raise SystemExit('cannot map start %d' % i)

def map_end(i):                       # last surviving line at or before i
    j = i
    while j >= 0:
        if j in same: return same[j]
        j -= 1
    raise SystemExit('cannot map end %d' % i)

def correct(mapped, want, lo):
    """The diff can align a boundary line against an identical one elsewhere.
    Checked against the text it should be, and pulled back to the nearest
    line that matches."""
    if 0 <= mapped < len(cur) and cur[mapped] == want:
        return mapped
    for j in range(min(mapped, len(cur) - 1), lo - 1, -1):
        if cur[j] == want:
            return j
    raise SystemExit('cannot place end line %r' % want[:60])

# Ranges tile the file in order. Where one ends exactly where the next
# begins, its end is derived from that neighbour rather than matched by
# text - several boundaries are a blank line, and there are hundreds of
# those to align against. Only the starts, which are banner comments or
# declarations, are matched directly.
flat = sorted(([m, i, r] for m in man if not m.get('current') for i, r in enumerate(m['ranges'])),
              key=lambda x: x[2][0])
starts = {}
for m, i, (a, b) in flat:
    na = map_start(a - 1)
    if cur[na] != ref[a - 1]:
        raise SystemExit('%s: start line does not match after mapping' % m['file'])
    starts[(m['file'], i)] = na

moved = 0
for idx, (m, i, r) in enumerate(flat):
    a, b = r
    na = starts[(m['file'], i)]
    nxt = flat[idx + 1] if idx + 1 < len(flat) else None
    if nxt and nxt[2][0] == b + 1:
        nb = starts[(nxt[0]['file'], nxt[1])] - 1      # adjacent: exact by construction
    else:
        nb = correct(map_end(b - 1), ref[b - 1], na)
    if (na + 1, nb + 1) != (a, b):
        moved += 1
    m['ranges'][i] = [na + 1, nb + 1]

# --- no module may reach into the next one -------------------------------
# A boundary line like "}" can be matched against the wrong one, and the
# only symptom is a module that quietly swallows its neighbour. Ranges are
# ordered and disjoint by construction, so that is checkable.
flat = sorted(([m['file'], i, r] for m in man for i, r in enumerate(m['ranges'])), key=lambda x: x[2][0])
clamped = 0
for (fa, ia, ra), (fb, ib, rb) in zip(flat, flat[1:]):
    if ra[1] >= rb[0]:
        print('  OVERLAP %s [..%d] runs into %s [%d..]' % (fa, ra[1], fb, rb[0]))
        clamped += 1
if clamped:
    raise SystemExit('%d overlap(s) - a module would swallow its neighbour; not writing' % clamped)

json.dump(man, open('tools/manifest.json', 'w', encoding='utf-8'), indent=1)
print('re-anchored %d modules, %d range(s) moved, no overlaps' % (len(man), moved))
