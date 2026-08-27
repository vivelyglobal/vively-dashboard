import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { DB, SERVER, byCampaign, persist, persistState, serverSave, subscribe, subscribeStatus } from '../model/db.js';
import { recomputeCreatorStats } from '../model/creators.js';
import { campaignStats } from '../model/stats.js';
import { selectable } from '../model/settings.js';
import { SYNC } from '../sync/sheets.js';
import { $, $$, esc } from '../ui/dom.js';
import { closeDrawer } from '../ui/overlay.js';
import { avatarHtml, downloadFile, flagPill, statusPill, toCsv } from '../ui/html.js';
import { kmb } from '../lib/format.js';

import { state, activeCampaigns } from '../views/overview.js';
import { renderOverview } from '../views/overview.js';
import { renderCampaignSection } from '../views/campaigns.js';
import { renderCreators, showCreator } from '../views/creators.js';
import { renderAnalytics } from '../views/analytics.js';
import { renderMessagesSection } from '../views/messages.js';
import { renderContracts } from '../views/contracts.js';
import { renderSettings } from '../views/settings.js';

import { SECTIONS, panelFor, parseHash, titleFor } from './routes.js';
import { applyTheme, initialTheme, toggleTheme } from './theme.js';
import AuthModal from './AuthModal.jsx';
import { loadAuthUser, saveAuthUser } from './auth.js';
import SaveBadge from './SaveBadge.jsx';

/* which legacy renderer owns each section — the one place that still
   reaches for innerHTML, and the line the conversion is eating into */
const RENDERERS = {
  campaigns: renderCampaignSection,
  creators:  renderCreators,
  analytics: renderAnalytics,
  messages:  renderMessagesSection,
  contracts: renderContracts,
  settings:  (view, item) => renderSettings(view, item),
  overview:  renderOverview
};

export default function App() {
  const [route, setRoute] = useState(() => parseHash());
  const [version, bump] = useReducer((n) => n + 1, 0);
  const [, bumpStatus] = useReducer((n) => n + 1, 0);
  const [panelQ, setPanelQ] = useState(state.panelQ);
  const [theme, setTheme] = useState(initialTheme);
  const [user, setUser] = useState(loadAuthUser);
  const [auth, setAuth] = useState({ open: false, mode: 'login' });
  const viewRef = useRef(null);

  /* the data layer no longer knows what is on screen; it just says
     "something changed" and the shell repaints */
  useEffect(() => subscribe(bump), []);
  /* a save finishing repaints the badge and nothing else */
  useEffect(() => subscribeStatus(bumpStatus), []);
  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const { section, item, tab, tabs } = route;

  /* paint the panel body. Still the legacy renderers writing HTML into
     one node — replaced section by section, without the rest moving. */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    recomputeCreatorStats();
    if ($('#drawer') && $('#drawer').classList.contains('open') && !window.__keepDrawer) closeDrawer();
    view.innerHTML = '';
    (RENDERERS[section] || renderOverview)(view, item, tab);
    window.scrollTo(0, 0);
    view.scrollTop = 0;
    persist();
    /* Deliberately keyed: the panel is rebuilt when the route changes or
       when the data layer says something changed — not on every incidental
       React render. Rebuilding it wipes the listeners the view just wired
       up, and closes any drawer that was opened from inside it. */
  }, [section, item, tab, version]);

  const sectLabel = (SECTIONS.find((s) => s.id === section) || {}).label;
  const crumb = (section === 'campaigns' || section === 'messages') && byCampaign[item]
    ? sectLabel + ' · ' + byCampaign[item].name
    : sectLabel;

  const panel = panelFor(section, item);

  const onKey = useCallback((e) => {
    if (e.key === 'Escape') closeDrawer();
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#globalSearch').focus(); }
    if (e.key === '[' && !typing) { e.preventDefault(); togglePanel(); }
    if ((e.key === 't' || e.key === 'T') && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); setTheme(toggleTheme());
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onKey]);

  useEffect(() => { if (window.innerWidth <= 1080) togglePanel(false); }, []);

  /* nothing is readable until someone is signed in */
  const locked = !user;
  useEffect(() => {
    document.body.classList.toggle('auth-locked', locked);
    if (locked) setAuth({ open: true, mode: 'login' });
    else setAuth((a) => ({ ...a, open: false }));
  }, [locked]);

  function signedIn(u) { setUser(u); saveAuthUser(u); }
  function signOut() { setUser(null); saveAuthUser(null); }

  function exportAll() {
    const rows = DB.campaigns.map((cp) => {
      const s = campaignStats(cp);
      return [cp.brand, cp.name, cp.kind, cp.status, cp.start, cp.end, cp.targetCreators, s.contacted, s.confirmed, s.delivered,
              s.views, s.reach, s.eng, (s.er * 100).toFixed(2) + '%', Math.round(s.spend), Math.round(s.cpm), s.cpv.toFixed(2), s.cpe.toFixed(2), s.viralCount];
    });
    downloadFile(toCsv(['brand','campaign','type','status','start','end','target','contacted','confirmed','delivered','views','reach','engagements','er','spend_krw','cpm','cpv','cpe','viral_posts'], rows),
      'vively-all-campaigns.csv', 'text/csv;charset=utf-8');
  }

  function saveNow() {
    if (SERVER.status === 'conflict' &&
        !confirm('This workspace was saved from another browser more recently. Overwrite it with what you see here?')) return;
    serverSave({ force: SERVER.status === 'conflict' });
  }

  return (
    <>
      <div className="app">
        <aside className="rail">
          <div className="brand"><div className="mark">V</div></div>
          <nav id="rail" style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            {SECTIONS.map((s) => (
              <a key={s.id} className={'rail-item ' + (s.id === section ? 'active' : '')} href={'#/' + s.id}>
                <span className="ico">{s.icon}</span>
                <span className="lb">{s.label}</span>
                {s.badge ? <span className="dotb">{s.badge()}</span> : null}
              </a>
            ))}
          </nav>
        </aside>

        <aside className="panel">
          <div className="panel-head">
            <span className="pt">{panel.title}</span>
            <button className="icon-btn no-print" title="Hide menu" onClick={() => togglePanel(false)}>&#8676;</button>
          </div>
          {panel.search ? (
            <div className="panel-search">
              <input type="search" id="panelQ" autoComplete="off"
                     placeholder={panel.searchPlaceholder || 'Filter…'}
                     value={panelQ}
                     onChange={(e) => { state.panelQ = e.target.value; setPanelQ(e.target.value); }} />
            </div>
          ) : null}
          <div className="panel-list">
            <PanelList panel={panel} section={section} item={item} />
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button className="icon-btn no-print" title="Show / hide menu" onClick={() => togglePanel()}>&#9776;</button>
            <div>
              <div className="crumb">{crumb}</div>
              <h1>{titleFor(section, item)}</h1>
            </div>
            <div className="spacer" />
            <GlobalSearch />
            <SaveBadge server={SERVER} sync={SYNC} persistState={persistState} />
            <button className="btn primary sm no-print" title="Save this workspace to the server now" onClick={saveNow}>Save</button>
            <button className="theme-btn no-print" aria-label="Switch theme"
                    title={theme === 'light' ? 'Switch to dark (T)' : 'Switch to light (T)'}
                    onClick={() => setTheme(toggleTheme())}>{theme === 'light' ? '☀' : '☾'}</button>
            <AuthButtons user={user}
                         onLogin={() => setAuth({ open: true, mode: 'login' })}
                         onSignup={() => setAuth({ open: true, mode: 'signup' })}
                         onLogout={signOut} />
            <button className="btn sm no-print" onClick={exportAll}>Export</button>
          </header>

          <nav className="tabbar no-print">
            {tabs.map(([id, label]) => (
              <a key={id} className={'tab ' + (id === tab ? 'active' : '')}
                 href={`#/${section}/${item}/${id}`}>{label}</a>
            ))}
          </nav>

          {/* the legacy renderers own the inside of this node */}
          <main className="content" id="view" ref={viewRef} />
        </div>
      </div>

      <div className="scrim" id="scrim" onClick={closeDrawer} />
      <aside className="drawer" id="drawer">
        <div className="drawer-head">
          <div id="drawerTitle" style={{ fontSize: 15, fontWeight: 500 }}>Details</div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={closeDrawer}>&times;</button>
        </div>
        <div className="drawer-body" id="drawerBody" />
      </aside>

      <div className="toast" id="toast" />

      <AuthModal open={auth.open} mode={auth.mode} locked={locked}
                 onMode={(mode) => setAuth((a) => ({ ...a, mode }))}
                 onClose={() => { if (!locked) setAuth((a) => ({ ...a, open: false })); }}
                 onAuthenticated={signedIn} />
    </>
  );
}

function PanelList({ panel, section, item }) {
  if (!panel.groups.some((g) => g.items.length)) {
    return (
      <div className="panel-empty">
        {state.panelQ ? 'Nothing matches that filter.'
          : (section === 'campaigns' || section === 'messages')
            ? 'No campaigns yet. Import a sheet or create one.'
            : 'Nothing here yet.'}
      </div>
    );
  }
  return panel.groups.map((g, gi) => (
    <React.Fragment key={gi}>
      {g.label ? <div className="panel-group">{g.label}</div> : null}
      {g.items.map((it) => (
        <a key={it.id} className={'panel-item ' + (it.id === item ? 'active' : '')} href={`#/${section}/${it.id}`}>
          {it.dot ? <span className="sdot" style={{ background: it.dot }} /> : null}
          <span className="pi-main">
            <span className="pi-t">{it.title}</span>
            {it.sub ? <span className="pi-s" style={{ display: 'block' }}>{it.sub}</span> : null}
          </span>
          {it.right ? <span className="pi-n">{it.right}</span> : null}
        </a>
      ))}
    </React.Fragment>
  ));
}

/* the type-ahead over creators and campaigns, unchanged in behaviour */
function GlobalSearch() {
  const boxRef = useRef(null);
  return (
    <div className="searchbox no-print">
      <span className="ico">&#9906;</span>
      <input type="search" id="globalSearch" placeholder="Search creators, campaigns…" autoComplete="off"
        onBlur={() => setTimeout(() => boxRef.current && boxRef.current.classList.remove('open'), 160)}
        onInput={(e) => {
          const box = boxRef.current;
          const q = e.target.value.trim().toLowerCase();
          if (q.length < 2) { box.classList.remove('open'); return; }
          const cs = selectable(DB.creators).filter((c) => (c.handle + c.name + c.categories.join('')).toLowerCase().includes(q)).slice(0, 6);
          const cps = DB.campaigns.filter((c) => (c.brand + c.name + c.kind).toLowerCase().includes(q)).slice(0, 5);
          box.innerHTML =
            (cps.length ? `<div class="ac-empty" style="padding:8px 12px 4px">Campaigns</div>` + cps.map((c) =>
              `<div class="ac-item" data-go="#/campaigns/${c.id}/roster"><div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(c.brand)}</div><div style="font-size:11.5px;color:var(--text-3)">${esc(c.name)}</div></div>${statusPill(c.status)}</div>`).join('') : '') +
            (cs.length ? `<div class="ac-empty" style="padding:8px 12px 4px">Creators</div>` + cs.map((c) =>
              `<div class="ac-item" data-cr="${c.id}">${avatarHtml(c.handle)}<div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(c.handle)} ${flagPill(c.flag)}</div><div style="font-size:11.5px;color:var(--text-3)">${kmb(c.followers)} · ${esc(c.country)}</div></div></div>`).join('') : '') ||
            `<div class="ac-empty">No matches.</div>`;
          box.classList.add('open');
          $$('.ac-item', box).forEach((it) => it.addEventListener('mousedown', () => {
            box.classList.remove('open'); e.target.value = '';
            if (it.dataset.go) location.hash = it.dataset.go; else showCreator(it.dataset.cr);
          }));
        }} />
      <div className="ac-list" ref={boxRef} style={{ position: 'absolute', top: 52, right: 24, width: 420 }} />
    </div>
  );
}

function AuthButtons({ user, onLogin, onSignup, onLogout }) {
  return (
    <div className="auth-actions no-print">
      <button className="btn sm" onClick={user ? onLogout : onLogin}>{user ? 'Logout' : 'Login'}</button>
      <button className="btn sm primary" disabled={!!user} onClick={onSignup}>
        {user ? (user.name || user.email) : 'Signup'}
      </button>
    </div>
  );
}

export function togglePanel(force) {
  const closed = force != null ? !force : !document.body.classList.contains('panel-closed');
  document.body.classList.toggle('panel-closed', closed);
  document.body.classList.toggle('panel-open', !closed);
}
