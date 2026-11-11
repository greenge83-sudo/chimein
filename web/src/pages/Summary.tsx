import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api, auth, fmtDuration, headersFor, type Card, type Creds } from '../lib/api';
import { useT } from '../lib/i18n';
import { CardView } from '../components/CardView';
import { LangSwitch } from '../components/Bits';
import { SpeakerRename } from './Host';

interface Minutes {
  summary_md: string; topics: { title: string; conclusion: string }[]; decisions: string[];
  action_items: { task: string; owner: string | null; due: string | null }[]; speaker_points: { speaker: string; points: string[] }[];
  status: string; version: number;
}

export default function Summary() {
  const t = useT();
  const nav = useNavigate();
  const { id = '' } = useParams();
  const role = auth.participantToken(id) && !auth.hostToken() ? 'guest' : 'host';
  const creds = useMemo<Creds>(() => ({ role, meetingId: id }), [id, role]);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Minutes | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const load = () => api('GET', `/api/meetings/${id}/minutes`, undefined, creds).then((x) => { setD(x); setShareUrl(x.meeting.share_token ? `${location.origin}/s/${x.meeting.share_token}` : null); }).catch((e) => setErr(e.code));
  useEffect(() => { load(); }, [id]);
  // 纪要生成完成时自动刷新
  useEffect(() => {
    const s = io({ auth: { meetingId: id, hostToken: role === 'host' ? auth.hostToken() : undefined, participantToken: role === 'guest' ? auth.participantToken(id) : undefined }, transports: ['websocket', 'polling'] });
    s.on('minutes.status', () => load());
    return () => { s.close(); };
  }, [id]);

  if (err) return <div className="page narrow"><p className="error">{err}</p><Link to="/meetings">{t('back')}</Link></div>;
  if (!d) return <div className="page narrow muted">…</div>;
  const m = d.meeting;
  const mi: Minutes | null = d.minutes;
  const isHost = role === 'host';
  const dur = m.started_at && m.ended_at ? m.elapsedMs : 0;

  const exportMd = async () => {
    const r = await fetch(`/api/meetings/${id}/export?format=md`, { headers: headersFor(creds) });
    const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${m.title}.md`; a.click();
  };

  return (
    <div className="page summary">
      <header className="bar no-print">
        {isHost ? <Link to="/meetings" className="link">← {t('meetings')}</Link> : <span />}
        <LangSwitch />
      </header>
      <h1>{m.title}</h1>
      <p className="muted">{m.started_at && new Date(m.started_at).toLocaleString()}{dur > 0 && ` · ${fmtDuration(dur)}`}{m.counterparties.length > 0 && ` · ${m.counterparties.join(' / ')}`}</p>

      {isHost && (
        <div className="row wrap no-print toolbar">
          <button onClick={exportMd}>{t('exportMd')}</button>
          <button onClick={() => window.print()}>{t('print')}</button>
          {shareUrl
            ? <><code className="small">{shareUrl}</code><button onClick={() => navigator.clipboard?.writeText(shareUrl)}>{t('copy')}</button>
              <button className="link" onClick={async () => { await api('POST', `/api/meetings/${id}/share`, { enabled: false }, creds); setShareUrl(null); }}>{t('unshare')}</button></>
            : <button onClick={async () => { const r = await api('POST', `/api/meetings/${id}/share`, { enabled: true }, creds); setShareUrl(`${location.origin}/s/${r.share_token}`); }}>{t('share')}</button>}
          <span className="muted small">{t('shareNote')}</span>
        </div>
      )}

      <section>
        <div className="row between"><h2>{t('minutes')}</h2>
          {isHost && mi?.status === 'ready' && !editing && <div className="row no-print">
            <button onClick={() => setEditing(structuredClone(mi))}>{t('edit')}</button>
            <button className="subtle" onClick={() => api('POST', `/api/meetings/${id}/minutes/regenerate`, {}, creds).then(load)}>{t('regenerate')}</button>
          </div>}
        </div>
        {(!mi || mi.status === 'generating' || mi.status === 'pending') && <p className="muted">{t('generating')}</p>}
        {mi?.status === 'failed' && <p className="error">{t('minutesFailed')} {isHost && <button onClick={() => api('POST', `/api/meetings/${id}/minutes/regenerate`, {}, creds).then(load)}>{t('regenerate')}</button>}</p>}
        {mi?.status === 'ready' && !editing && <MinutesView mi={mi} />}
        {editing && <MinutesEditor mi={editing} onChange={setEditing} onCancel={() => setEditing(null)}
          onSave={async () => { await api('PUT', `/api/meetings/${id}/minutes`, editing, creds); setEditing(null); load(); }} />}
      </section>

      {d.cards.length > 0 && (
        <section>
          <h2>{t('cardReview')}</h2>
          <div className="card-grid">{d.cards.filter((c: Card) => !(c.type === 'iteration' && c.parent_card_id)).map((c: Card) => (
            <CardView key={c.id} card={c} updates={d.cards.filter((x: Card) => x.parent_card_id === c.id && x.type === 'iteration')} />
          ))}</div>
        </section>
      )}

      {isHost && d.speakers?.length > 0 && <SpeakerRename meetingId={id} creds={creds} speakers={d.speakers} onDone={load} />}

      {isHost && d.metrics && (
        <section className="no-print">
          <h3>{t('metrics')}</h3>
          <p className="small muted">
            {t('cards')} {d.metrics.cardsShown} · {t('usefulRate')} {d.metrics.usefulRate == null ? '—' : `${Math.round(d.metrics.usefulRate * 100)}%`} ·{' '}
            {t('irrelevantRate')} {d.metrics.irrelevantRate == null ? '—' : `${Math.round(d.metrics.irrelevantRate * 100)}%`} · {t('echoes')} {d.metrics.echoSegments} ·{' '}
            {t('reqDone')} {d.metrics.requestsFulfilled}/{d.metrics.requests} · {t('p90')} {d.metrics.p90CardLatencyMs == null ? '—' : `${(d.metrics.p90CardLatencyMs / 1000).toFixed(1)}s`}
          </p>
          {d.usage?.length > 0 && <p className="small muted">{t('usage')}：{d.usage.map((u: any) => `${u.kind} ${Math.round(u.quantity * 100) / 100}${u.cost ? ` ($${u.cost.toFixed(3)})` : ''}`).join(' · ')}</p>}
        </section>
      )}

      {isHost && d.transcript?.length > 0 && (
        <details className="no-print"><summary>{t('fullTranscript')}</summary>
          <div className="transcript static">{d.transcript.map((s: any) => <p key={s.id} className="seg"><b>{s.speaker_name ?? s.speaker_label ?? '—'}</b> {s.text}</p>)}</div>
        </details>
      )}

      {isHost && (
        <p className="no-print pad"><button className="danger" onClick={async () => {
          if (!confirm(t('confirmDelete'))) return;
          await api('DELETE', `/api/meetings/${id}`, undefined, creds); nav('/meetings');
        }}>{t('deleteMeeting')}</button></p>
      )}
    </div>
  );
}

export function MinutesView({ mi }: { mi: Minutes }) {
  const t = useT();
  return (
    <div className="minutes">
      <h3>{t('summary')}</h3>
      <Markdownish text={mi.summary_md} />
      {mi.topics.length > 0 && <><h3>{t('topics')}</h3><ul>{mi.topics.map((x, i) => <li key={i}><b>{x.title}</b>：{x.conclusion}</li>)}</ul></>}
      {mi.decisions.length > 0 && <><h3>{t('decisions')}</h3><ul>{mi.decisions.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      {mi.action_items.length > 0 && <><h3>{t('actions')}</h3>
        <table className="actions"><thead><tr><th>{t('actions')}</th><th>{t('owner')}</th><th>{t('due')}</th></tr></thead>
          <tbody>{mi.action_items.map((a, i) => <tr key={i}><td>{a.task}</td><td>{a.owner ?? ''}</td><td>{a.due ?? ''}</td></tr>)}</tbody></table></>}
      {mi.speaker_points.length > 0 && <><h3>{t('speakerPoints')}</h3>{mi.speaker_points.map((s, i) => <div key={i}><b>{s.speaker}</b><ul>{s.points.map((p, j) => <li key={j}>{p}</li>)}</ul></div>)}</>}
    </div>
  );
}

/** 极简 Markdown：粗体与换行（纪要概要只需要这些，不引入 HTML 注入风险） */
function Markdownish({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((p, i) => (
    <p key={i}>{p.split(/(\*\*[^*]+\*\*)/g).map((s, j) => (s.startsWith('**') ? <b key={j}>{s.slice(2, -2)}</b> : <span key={j}>{s}</span>))}</p>
  ))}</>;
}

function MinutesEditor({ mi, onChange, onSave, onCancel }: { mi: Minutes; onChange: (m: Minutes) => void; onSave: () => void; onCancel: () => void }) {
  const t = useT();
  const lines = (a: string[]) => a.join('\n');
  const split = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <div className="stack minutes-edit">
      <label>{t('summary')}<textarea rows={5} value={mi.summary_md} onChange={(e) => onChange({ ...mi, summary_md: e.target.value })} /></label>
      <label>{t('topics')}（标题：结论，每行一条）<textarea rows={4} value={mi.topics.map((x) => `${x.title}：${x.conclusion}`).join('\n')}
        onChange={(e) => onChange({ ...mi, topics: split(e.target.value).map((l) => { const [title, ...rest] = l.split(/[:：]/); return { title, conclusion: rest.join('：') }; }) })} /></label>
      <label>{t('decisions')}<textarea rows={3} value={lines(mi.decisions)} onChange={(e) => onChange({ ...mi, decisions: split(e.target.value) })} /></label>
      <div>{t('actions')}
        {mi.action_items.map((a, i) => (
          <div key={i} className="row">
            <input value={a.task} onChange={(e) => { const x = [...mi.action_items]; x[i] = { ...a, task: e.target.value }; onChange({ ...mi, action_items: x }); }} />
            <input placeholder={t('owner')} value={a.owner ?? ''} onChange={(e) => { const x = [...mi.action_items]; x[i] = { ...a, owner: e.target.value || null }; onChange({ ...mi, action_items: x }); }} />
            <input placeholder={t('due')} value={a.due ?? ''} onChange={(e) => { const x = [...mi.action_items]; x[i] = { ...a, due: e.target.value || null }; onChange({ ...mi, action_items: x }); }} />
            <button className="link" onClick={() => onChange({ ...mi, action_items: mi.action_items.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <button className="link" onClick={() => onChange({ ...mi, action_items: [...mi.action_items, { task: '', owner: null, due: null }] })}>+</button>
      </div>
      <div className="row"><button className="primary" onClick={onSave}>{t('saveEdit')}</button><button onClick={onCancel}>{t('cancel')}</button></div>
    </div>
  );
}
