import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth, fmtDuration } from '../lib/api';
import { useT } from '../lib/i18n';
import { LangSwitch } from '../components/Bits';

export default function Meetings() {
  const t = useT();
  const nav = useNavigate();
  const [list, setList] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [usage, setUsage] = useState<any>(null);
  useEffect(() => {
    const h = setTimeout(() => api('GET', `/api/meetings${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setList).catch((e) => { if (e.status === 401) nav('/login'); }), 200);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => { api('GET', '/api/usage').then(setUsage).catch(() => {}); }, []);
  const statusLabel = (s: string) => (s === 'live' ? '● LIVE' : s === 'paused' ? '❚❚' : s === 'draft' ? '—' : '');
  return (
    <div className="page">
      <header className="bar">
        <h1 className="brand">{t('appName')}</h1>
        <div className="row">
          <LangSwitch />
          <button className="link" onClick={async () => { await api('POST', '/api/auth/logout').catch(() => {}); auth.setHostToken(null); nav('/login'); }}>{t('logout')}</button>
        </div>
      </header>
      <div className="row between wrap">
        <h2>{t('meetings')}</h2>
        <Link to="/meetings/new" className="btn primary">+ {t('newMeeting')}</Link>
      </div>
      <input className="search" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {list && !list.length && <p className="muted">{t('noMeetings')}</p>}
      <ul className="meeting-list">
        {list?.map((m) => (
          <li key={m.id}>
            <Link to={m.status === 'ended' ? `/m/${m.id}/summary` : `/m/${m.id}/host`}>
              <div className="row between"><strong>{m.title}</strong><span className={`st st-${m.status}`}>{statusLabel(m.status)}</span></div>
              <div className="muted small">
                {new Date(m.created_at).toLocaleString()} · {t(`preset.${m.preset}` as any)}
                {m.counterparties.length > 0 && ` · ${m.counterparties.join(' / ')}`}
                {m.duration_ms > 0 && ` · ${t('duration')} ${fmtDuration(m.duration_ms)}`} · {m.card_count} {t('cards')}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {usage && (
        <details className="usage">
          <summary>{t('usage')}（{usage.plan?.name}）</summary>
          <ul>{usage.month.map((u: any) => <li key={u.kind}>{u.kind}: {Math.round(u.quantity * 100) / 100}{u.cost ? ` · $${u.cost.toFixed(3)}` : ''}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
