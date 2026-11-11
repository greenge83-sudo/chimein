import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../lib/api';
import { useT, getLang } from '../lib/i18n';
import { LangSwitch } from '../components/Bits';

export default function Auth() {
  const t = useT();
  const nav = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="page narrow auth">
      <div className="top-right"><LangSwitch /></div>
      <h1 className="brand">{t('appName')}</h1>
      <p className="muted">{t('tagline')}</p>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true); setErr('');
        try {
          const r = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register',
            { email: f.get('email'), password: f.get('password'), ...(mode === 'register' ? { name: f.get('name') || undefined, locale: getLang() } : {}) });
          auth.setHostToken(r.token);
          nav('/meetings');
        } catch (e: any) { setErr(e.code ?? String(e)); } finally { setBusy(false); }
      }}>
        {mode === 'register' && <label>{t('name')}<input name="name" maxLength={100} /></label>}
        <label>{t('email')}<input name="email" type="email" required autoComplete="email" /></label>
        <label>{t('password')}<input name="password" type="password" minLength={8} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {err && <p className="error">{err}</p>}
        <button className="primary big" disabled={busy}>{mode === 'login' ? t('login') : t('register')}</button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? t('noAccount') : t('hasAccount')}</button>
      </form>
    </div>
  );
}
