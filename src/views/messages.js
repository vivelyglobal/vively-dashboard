import { funnelView } from '../charts/index.js';
import { parseVisitSlot } from '../import/notion.js';
import { dLabel } from '../lib/dates.js';
import { num, pct, won, wonK } from '../lib/format.js';
import { DB, byCampaign, byCreator } from '../model/db.js';
import { campaignStats, funnelOf, partsOf } from '../model/stats.js';
import { stageOf } from '../model/vocab.js';
import { $, esc } from '../ui/dom.js';
import { copyText, downloadFile, emptyState, toCsv } from '../ui/html.js';
import { toast } from '../ui/overlay.js';
import { activeCampaigns, state } from './overview.js';

/* ============================================================
   MESSAGE GENERATOR
   Turns the campaign note into the message you actually send.
   ============================================================ */
export const MSG_KINDS = [
  ['outreach',    'First outreach DM',      'sourced'],
  ['followup',    'Follow-up nudge',        'contacted'],
  ['confirm',     'Confirmation to participate', 'shortlisted'],
  ['visitconfirm','Confirm visit date & time', 'confirmed'],
  ['address',     'Address / visit booking', 'confirmed'],
  ['shipped',     'Shipped + guidelines',   'shipped'],
  ['reminder',    'Posting reminder',       'shipped'],
  ['thanks',      'Post-live thank you + analytics request', 'live'],
  ['decline',     'Polite decline',         'replied']
];

/* pull the useful lines out of a free-text campaign note */
export function parseNote(note) {
  const lines = String(note || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const find = (re) => (lines.find((l) => re.test(l)) || '').replace(/^[^:]*:\s*/, '');
  return {
    gets:     find(/what the creator gets|creator gets|제공/i),
    needs:    find(/what we need back|deliverable|need back|촬영/i),
    window:   find(/posting window|window|기한|마감/i),
    tagging:  find(/must tag|tag |해시태그/i),
    rules:    lines.filter((l) => /^no |avoid|preferred|please keep/i.test(l)).join(' '),
    all: lines
  };
}

export const TONE = {
  friendly:     { hi: (n) => `Hi ${n}! 👋`, sign: 'Warmly,\nVIVELY', pace: '' },
  professional: { hi: (n) => `Hello ${n},`, sign: 'Best regards,\nVIVELY Creator Partnerships', pace: '' },
  casual:       { hi: (n) => `hey ${n}!`,   sign: '— VIVELY', pace: '' }
};

export function buildMessage(kind, cp, cr, tone, lang) {
  const n  = cr ? cr.handle.replace('@', '') : '{{creator}}';
  const t  = TONE[tone] || TONE.friendly;
  const p  = parseNote(cp.note);
  const brand = cp.brand;
  const deadline = dLabel(cp.end);
  const gets  = p.gets  || `the full ${brand} product set, shipped free`;
  const needs = p.needs || cp.deliverables;
  const win   = p.window || 'within 10 days of delivery';
  const tagging = p.tagging || `tag @${brand.toLowerCase().replace(/\W/g, '')} and use ${cp.hashtags.join(' ')}`;
  /* don't repeat a rule that already appears inside the posting-window line */
  const rules = (p.rules || '').split(/(?<=\.)\s+/).filter((r) => r && !win.includes(r.trim())).join(' ');
  const personal = cr
    ? `I've been following your ${cr.categories[0].toLowerCase()} content — the way you shoot ${cr.platform === 'TikTok' ? 'your TikToks' : 'your reels'} is exactly the mood ${brand} is going for.`
    : `I've been following your content and it's exactly the mood ${brand} is going for.`;

  /* the slot this creator picked on the form, so the confirmation can quote
     it back at them instead of asking for a date they already gave */
  const part = cr ? DB.participants.find((x) => x.campaignId === cp.id && x.creatorId === cr.id) : null;
  const slotRaw = (part && part.visitAt) || '';
  const slotDate = parseVisitSlot(slotRaw);
  const hasSlotTime = /\d{1,2}:\d{2}/.test(slotRaw);
  const slot = slotDate
    ? slotDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) +
      (hasSlotTime ? ' at ' + slotDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '')
    : (slotRaw || '{{visit date & time}}');
  const slotKo = slotRaw || '{{방문 일시}}';
  const venueLine = p.all.find((l) => /location|주소|address|store|venue/i.test(l)) || '';
  const venue = venueLine.replace(/^[^:]*:\s*/, '') || brand;

  const EN = {
    outreach: `${t.hi(n)}

I'm reaching out from VIVELY — we run creator campaigns in Korea and across Southeast Asia. We're working with ${brand} on a ${cp.kind.toLowerCase()} campaign${cp.market ? ` for the ${cp.market} market` : ''}, and I'd love to have you on it.

${personal}

What you'd get: ${gets}
What we'd need: ${needs}
Timing: ${win} — campaign runs until ${deadline}
${cr && cr.rate ? `Fee: negotiable, we budget around ${wonK(cr.rate)} for creators at your size.\n` : ''}
If that sounds interesting, just reply here and I'll send the full brief. No pressure either way — thank you for reading!

${t.sign}`,

    followup: `${t.hi(n)}

Just floating this back up — we're closing the ${brand} lineup this week and I'd hate for you to miss it. Same offer as before: ${gets}, in exchange for ${needs.toLowerCase()}.

A yes or no is totally fine, I just don't want to keep you in limbo. 🙏

${t.sign}`,

    confirm: `${t.hi(n)}

Great news — ${brand} confirmed you for the campaign! 🎉

Here's everything in one place:
• Deliverables: ${needs}
• Posting window: ${win}
• Campaign ends: ${deadline}
• Tagging: ${tagging}
${rules ? `• Please note: ${rules}\n` : ''}${cr && cr.rate ? `• Fee: ${wonK(cr.rate)}, paid within 14 days of the post going live\n` : ''}
To lock it in, could you reply with:
1. Full name
2. Shipping address + postcode
3. Phone number for the courier
4. The date you expect to post

Once I have those I'll get the parcel out the same day. Really excited to see what you make!

${t.sign}`,

    visitconfirm: `${t.hi(n)}

You're confirmed for ${brand} — and I've got you down for:

📅 ${slot}
📍 ${venue}

Could you just reply "confirmed" so I know the slot works? If you need a different day or time, tell me what suits you and I'll move it — no problem at all.

A few things worth knowing before you come:
• Please arrive within 10 minutes of the booked time — the seating is held for you
• ${needs}
• ${tagging}
• Post ${win}
${rules ? `• ${rules}\n` : ''}
If anything changes on the day, message me here and I'll sort it out. See you then!

${t.sign}`,

    address: `${t.hi(n)}

Thanks for confirming! To get your ${brand} package out, could you send me:

1. Full name (as it should appear on the parcel)
2. Full shipping address including postcode
3. Contact number for the courier
${cp.kind === 'Store visit' ? '4. Two dates that work for your store visit\n' : '4. Your expected posting date\n'}
I'll confirm dispatch as soon as it's on the way.

${t.sign}`,

    shipped: `${t.hi(n)}

Your ${brand} package is on its way — you should have it in 2–4 days. 📦

Quick recap of what we need:
• ${needs}
• Post ${win}
• ${tagging}
${rules ? `• ${rules}\n` : ''}
Before you post, send me the draft here so ${brand} can have a quick look — usually a same-day turnaround from our side.

Shoot in natural light if you can, and please keep it in your own voice. The whole point is that it sounds like you, not like an ad.

${t.sign}`,

    reminder: `${t.hi(n)}

Hope you're loving the ${brand} set! Just a gentle nudge — the campaign wraps on ${deadline}, so we'd love to have your ${needs.toLowerCase()} up before then.

If you need a couple more days, just tell me and I'll adjust the schedule. And if you'd like a hand with hooks or caption ideas, I'm happy to send a few.

${t.sign}`,

    thanks: `${t.hi(n)}

Your post is live and it's doing really well — thank you! 🙌

One last small favour: could you send screenshots of the post insights around day 7 and day 14? Specifically views, reach, likes, comments, shares and saves. ${brand} builds their report from those numbers and it also helps me argue for a bigger budget for you next time.

${cr && cr.rate ? 'Payment is being processed and will land within 14 days.\n\n' : ''}Would you be open to working together again? I have two more campaigns in your category coming up next month.

${t.sign}`,

    decline: `${t.hi(n)}

Thank you so much for your interest in the ${brand} campaign, and for taking the time to reply.

For this round ${brand} has gone in a slightly different direction with the lineup, so we won't be moving forward this time. That is genuinely not a reflection of your work — the shortlist was tight.

I'd love to keep you on our list for upcoming campaigns${cr ? ` in ${cr.categories[0].toLowerCase()}` : ''}. Would that be alright?

${t.sign}`
  };

  const KO = {
    outreach: `안녕하세요 ${n}님 :)

한국과 동남아시아에서 크리에이터 캠페인을 진행하는 VIVELY입니다. 이번에 ${brand} ${cp.kind} 캠페인${cp.market ? ` (${cp.market} 타깃)` : ''}을 준비하고 있어 연락드렸어요.

${n}님의 콘텐츠를 잘 보고 있었는데, ${brand}가 찾는 무드와 정말 잘 맞을 것 같습니다.

• 제공: ${gets}
• 요청 콘텐츠: ${needs}
• 일정: ${win} (캠페인 종료 ${deadline})
${cr && cr.rate ? `• 원고료: 협의 가능하며, 비슷한 규모의 크리에이터 기준 ${wonK(cr.rate)} 정도로 책정하고 있습니다.\n` : ''}
관심 있으시면 편하게 답장 주세요. 상세 브리프 바로 보내드리겠습니다. 감사합니다!

VIVELY 드림`,

    followup: `안녕하세요 ${n}님, VIVELY입니다 :)

${brand} 캠페인 라인업이 이번 주에 마감될 예정이라 한 번 더 안내드려요. 조건은 동일합니다 — ${gets} 제공, ${needs} 콘텐츠 요청.

참여가 어려우시면 편하게 말씀해주셔도 괜찮습니다. 감사합니다!

VIVELY 드림`,

    confirm: `안녕하세요 ${n}님! 좋은 소식이에요 🎉

${brand} 캠페인 최종 확정되셨습니다.

• 콘텐츠: ${needs}
• 업로드 기한: ${win} (캠페인 종료 ${deadline})
• 태그: ${tagging}
${rules ? `• 참고: ${rules}\n` : ''}${cr && cr.rate ? `• 원고료: ${wonK(cr.rate)} (업로드 후 14일 이내 지급)\n` : ''}
아래 정보를 답장으로 보내주시면 바로 발송 준비하겠습니다.
1. 성함
2. 주소 (우편번호 포함)
3. 연락처
4. 예상 업로드 날짜

감사합니다!

VIVELY 드림`,

    visitconfirm: `안녕하세요 ${n}님 :)

${brand} 캠페인 참여가 확정되었습니다! 예약 내용 안내드릴게요.

📅 ${slotKo}
📍 ${venue}

일정 확인하시고 "확인" 이라고 답장 주시면 됩니다. 혹시 다른 날짜나 시간이 편하시면 편하게 말씀해주세요, 조정 도와드리겠습니다.

방문 전 안내사항입니다.
• 예약 시간 10분 이내로 도착 부탁드립니다 (좌석이 준비되어 있습니다)
• 콘텐츠: ${needs}
• 태그: ${tagging}
• 업로드: ${win}
${rules ? `• ${rules}\n` : ''}
당일 변동사항이 있으면 언제든 메시지 주세요. 그럼 그때 뵙겠습니다!

VIVELY 드림`,

    address: `안녕하세요 ${n}님 :)

${brand} 제품 발송을 위해 아래 정보 부탁드립니다.

1. 성함
2. 주소 (우편번호 포함)
3. 연락처
${cp.kind === 'Store visit' ? '4. 방문 가능하신 날짜 2개\n' : '4. 예상 업로드 날짜\n'}
발송 완료되면 바로 알려드릴게요. 감사합니다!

VIVELY 드림`,

    shipped: `안녕하세요 ${n}님! ${brand} 제품이 발송되었습니다 📦 2~4일 내 도착 예정이에요.

다시 한번 안내드리면,
• 콘텐츠: ${needs}
• 업로드: ${win}
• 태그: ${tagging}
${rules ? `• ${rules}\n` : ''}
업로드 전에 초안을 먼저 보내주시면 ${brand} 측 확인 후 빠르게 회신드리겠습니다.

자연광에서 촬영해주시면 좋고, 무엇보다 ${n}님 평소 톤 그대로 편하게 만들어주세요!

VIVELY 드림`,

    reminder: `안녕하세요 ${n}님 :) ${brand} 제품은 잘 사용하고 계신가요?

캠페인이 ${deadline}에 종료되어 그 전에 업로드 부탁드리려고 연락드렸어요. 일정 조정이 필요하시면 편하게 말씀해주세요.

후킹이나 캡션 아이디어가 필요하시면 몇 가지 보내드릴게요!

VIVELY 드림`,

    thanks: `안녕하세요 ${n}님! 업로드해주신 콘텐츠 성과가 정말 좋아요 🙌 감사합니다.

마지막으로 한 가지만 부탁드릴게요. 업로드 후 7일차와 14일차에 인사이트 스크린샷(조회수, 도달, 좋아요, 댓글, 공유, 저장)을 보내주실 수 있을까요? ${brand} 리포트에 반영되고, 다음 캠페인 예산 협의에도 도움이 됩니다.

${cr && cr.rate ? '원고료는 14일 이내 지급 예정입니다.\n\n' : ''}다음 달에도 비슷한 카테고리 캠페인이 두 건 있는데, 함께해주실 수 있을까요?

VIVELY 드림`,

    decline: `안녕하세요 ${n}님, VIVELY입니다.

${brand} 캠페인에 관심 가져주시고 답변 주셔서 진심으로 감사드립니다.

이번 라운드는 브랜드 측에서 조금 다른 방향으로 라인업을 구성하게 되어, 아쉽게도 이번에는 함께하지 못하게 되었습니다. 콘텐츠 퀄리티와는 무관한 결정이었습니다.

앞으로 진행되는 캠페인에 다시 제안드려도 괜찮을까요? 감사합니다.

VIVELY 드림`
  };

  const en = EN[kind] || EN.outreach;
  const ko = KO[kind] || KO.outreach;
  return lang === 'ko' ? ko : lang === 'both' ? en + '\n\n— — — — —\n\n' + ko : en;
}

export function messagesTab(mount, cp) { renderMessageUI(mount, cp, 'outreach'); }

/* section view: layer 2 = campaign, layer 3 = which message */
export function renderMessagesSection(view, item, tab) {
  const cp = byCampaign[item] || activeCampaigns()[0] || DB.campaigns[0];
  if (!cp) {
    view.innerHTML = emptyState('No campaign to write about',
      'The message generator writes from a campaign note. Create or import a campaign first.', { icon: '\u2709' });
    return;
  }
  renderMessageUI(view, cp, tab || 'outreach');
}

export function renderMessageUI(mount, cp, kind) {
  const stageForKind = (MSG_KINDS.find((k) => k[0] === kind) || [])[2];
  const candidates = partsOf(cp.id).filter((p) => p.stage === stageForKind);
  const label = (MSG_KINDS.find((k) => k[0] === kind) || [])[1] || 'Message';

  mount.innerHTML = `
    <div class="grid g-1-2">
      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="card-head"><h3>Campaign note</h3><div class="sp"></div><button class="btn xs" id="mnSave">Save</button></div>
          <p class="card-sub">Every draft is written from this. Edit it and the message updates.</p>
          <textarea id="mnNote" style="min-height:19vh;font-size:12.5px">${esc(cp.note)}</textarea>
        </div>
        <div class="card">
          <div class="card-head"><h3>Settings</h3></div>
          <div class="inline-fields" style="margin-top:12px">
            <div class="field" style="flex:1"><label>Tone</label>
              <select id="mgTone">${Object.keys(TONE).map((t) => `<option value="${t}" ${state.msgTone === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
            <div class="field" style="flex:1"><label>Language</label>
              <select id="mgLang">${[['en', 'English'], ['ko', '한국어'], ['both', 'EN + 한국어']].map(([v, l]) => `<option value="${v}" ${state.msgLang === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Personalise for</label>
            <select id="mgCreator">
              <option value="">— generic template (merge fields) —</option>
              ${partsOf(cp.id).map((p) => { const cr = byCreator[p.creatorId]; return `<option value="${p.creatorId}">${esc(cr.handle)} — ${stageOf(p.stage).label}</option>`; }).join('')}
            </select></div>
          <div class="note">
            <strong>${candidates.length}</strong> creators sit at the “${esc(stageOf(stageForKind || 'sourced').label)}” stage — the natural audience for this message.
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
            ${['{{creator}}', '{{brand}}', '{{deliverables}}', '{{deadline}}'].map((v) => `<span class="kbd">${v}</span>`).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3 id="mgTitle">${esc(label)}</h3><div class="sp"></div>
          <button class="btn sm" id="mgCopy">Copy</button>
          <button class="btn sm" id="mgBulk">Generate for all ${candidates.length}</button>
        </div>
        <p class="card-sub">Edit freely before sending — this is a starting point, not a script.</p>
        <textarea id="mgOut" style="min-height:46vh;font-size:13px;line-height:1.7"></textarea>
      </div>
    </div>`;

  const draw = () => {
    const crId = $('#mgCreator').value;
    const cr = crId ? byCreator[crId] : null;
    state.msgTone = $('#mgTone').value; state.msgLang = $('#mgLang').value;
    $('#mgOut').value = buildMessage(kind, cp, cr, state.msgTone, state.msgLang);
    $('#mgTitle').textContent = label + (cr ? ' → ' + cr.handle : '');
  };
  ['mgTone', 'mgLang', 'mgCreator'].forEach((id) => $('#' + id).addEventListener('change', draw));
  draw();

  $('#mgCopy').addEventListener('click', () => copyText($('#mgOut').value, 'Message'));
  $('#mnSave').addEventListener('click', () => { cp.note = $('#mnNote').value; draw(); toast('Campaign note saved'); });
  $('#mgBulk').addEventListener('click', () => {
    if (!candidates.length) { toast('Nobody is at that stage right now'); return; }
    const rows = candidates.map((p) => {
      const cr = byCreator[p.creatorId];
      return [cr.handle, cr.name, cr.platform, cr.email, stageOf(p.stage).label, buildMessage(kind, cp, cr, state.msgTone, state.msgLang)];
    });
    downloadFile(toCsv(['handle', 'name', 'platform', 'email', 'stage', 'message'], rows),
      `vively-${cp.brand.toLowerCase().replace(/\W+/g, '-')}-${kind}-messages.csv`, 'text/csv;charset=utf-8');
  });
}

/* ------------------------------ brief tab ------------------------------ */
export function briefTab(mount, cp) {
  const s = campaignStats(cp);
  mount.innerHTML = `
    <div class="grid g-2-1">
      <div class="card">
        <div class="card-head"><h3>Campaign note</h3><div class="sp"></div><button class="btn xs" id="bfSave">Save</button></div>
        <p class="card-sub">The single source the message generator and the report intro read from.</p>
        <textarea id="bfNote" style="min-height:44vh;font-size:13px;line-height:1.7">${esc(cp.note)}</textarea>
      </div>
      <div>
        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>Setup</h3></div>
          <dl class="kv" style="margin-top:12px">
            <dt>Brand</dt><dd>${esc(cp.brand)}</dd>
            <dt>Type</dt><dd>${esc(cp.kind)}</dd>
            <dt>Category</dt><dd>${esc(cp.category)}</dd>
            <dt>Market</dt><dd>${esc(cp.market)}</dd>
            <dt>Dates</dt><dd>${cp.start} → ${cp.end}</dd>
            <dt>Target</dt><dd>${cp.targetCreators} creators</dd>
            <dt>Min followers</dt><dd>${num(cp.minFollowers)}</dd>
            <dt>Platforms</dt><dd>${cp.platforms.join(', ')}</dd>
            <dt>Deliverables</dt><dd>${esc(cp.deliverables)}</dd>
            <dt>Hashtags</dt><dd>${cp.hashtags.map((h) => `<span class="tag">${esc(h)}</span>`).join(' ')}</dd>
            <dt>Budget</dt><dd>${wonK(cp.budget)}</dd>
            <dt>Product / creator</dt><dd>${won(cp.productCostPer)}</dd>
            <dt>Ad spend</dt><dd>${wonK(cp.adSpend)}</dd>
            <dt>Spent so far</dt><dd>${wonK(s.spend)} <span style="color:var(--text-3)">(${pct(s.spend / (cp.budget || 1), 0)})</span></dd>
          </dl>
        </div>
        <div class="card">
          <div class="card-head"><h3>Funnel</h3></div>
          <div id="bfFunnel" style="margin-top:12px"></div>
        </div>
      </div>
    </div>`;
  $('#bfSave').addEventListener('click', () => { cp.note = $('#bfNote').value; toast('Saved'); });
  const f = funnelOf([cp.id]);
  funnelView($('#bfFunnel'), f.counts, f.total);
}
