import React, { useEffect, useRef, useState } from 'react';
import { sendAuth } from './auth.js';
import { toast } from '../ui/overlay.js';

export default function AuthModal({ open, mode, locked, onMode, onClose, onAuthenticated }) {
  const [busy, setBusy] = useState(false);
  const loginEmail = useRef(null);
  const signupName = useRef(null);

  useEffect(() => {
    if (!open) return;
    const el = mode === 'login' ? loginEmail.current : signupName.current;
    if (el) el.focus();
  }, [open, mode]);

  async function submit(e, path, read, ok) {
    e.preventDefault();
    const payload = read(e.target);
    if (!payload) return;
    setBusy(true);
    try {
      const data = await sendAuth(path, payload);
      onAuthenticated(data.user);
      e.target.reset();
      toast(ok(data.user));
    } catch (err) {
      toast(err.message || 'Auth failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={'auth-overlay' + (open ? ' open' : '')} aria-hidden={!open}
         onClick={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        <div className="auth-head">
          <h3 id="authTitle">Welcome to VIVELY</h3>
          <button className="icon-btn auth-close" aria-label="Close auth" onClick={onClose}>&times;</button>
        </div>
        <p className="auth-sub">Sign up dulu atau login kalau akun kamu sudah ada.</p>
        <div className="seg">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => onMode('login')}>Login</button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => onMode('signup')}>Signup</button>
        </div>

        <form className={'auth-form' + (mode === 'login' ? ' active' : '')}
              onSubmit={(e) => submit(e, '/api/login',
                (f) => ({ email: f.loginEmail.value.trim().toLowerCase(), password: f.loginPassword.value }),
                (u) => 'Login sukses. Hi ' + u.name)}>
          <div className="field">
            <label htmlFor="loginEmail">Email</label>
            <input id="loginEmail" name="loginEmail" ref={loginEmail} type="text" autoComplete="email" placeholder="you@company.com" required />
          </div>
          <div className="field">
            <label htmlFor="loginPassword">Password</label>
            <input id="loginPassword" name="loginPassword" type="password" autoComplete="current-password" placeholder="Password" required />
          </div>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Logging in…' : 'Login'}</button>
          <p className="auth-note">API: POST /api/login</p>
        </form>

        <form className={'auth-form' + (mode === 'signup' ? ' active' : '')}
              onSubmit={(e) => submit(e, '/api/signup', (f) => {
                const password = f.signupPassword.value;
                if (password.length < 8) { toast('Password minimal 8 karakter'); return null; }
                if (password !== f.signupConfirm.value) { toast('Konfirmasi password tidak sama'); return null; }
                return { name: f.signupName.value.trim(), email: f.signupEmail.value.trim().toLowerCase(), password };
              }, (u) => 'Signup berhasil. Welcome ' + u.name)}>
          <div className="auth-row">
            <div className="field">
              <label htmlFor="signupName">Full name</label>
              <input id="signupName" name="signupName" ref={signupName} type="text" autoComplete="name" placeholder="Your full name" required />
            </div>
            <div className="field">
              <label htmlFor="signupEmail">Email</label>
              <input id="signupEmail" name="signupEmail" type="text" autoComplete="email" placeholder="you@company.com" required />
            </div>
          </div>
          <div className="auth-row">
            <div className="field">
              <label htmlFor="signupPassword">Password</label>
              <input id="signupPassword" name="signupPassword" type="password" autoComplete="new-password" placeholder="Min 8 characters" required />
            </div>
            <div className="field">
              <label htmlFor="signupConfirm">Confirm password</label>
              <input id="signupConfirm" name="signupConfirm" type="password" autoComplete="new-password" placeholder="Repeat password" required />
            </div>
          </div>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          <p className="auth-note">API: POST /api/signup</p>
        </form>
      </section>
    </div>
  );
}
