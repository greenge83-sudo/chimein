import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDuration, type Card, type Creds } from '../lib/api';
import { useT } from '../lib/i18n';
import { cardStream, useMeeting } from '../lib/useMeeting';
import { listMics, startCapture, startBrowserAsr, type Capture } from '../lib/audio';
import { CardView } from '../components/CardView';
import { Acks, AiStatus, AskBox, LangSwitch, RequestList } from '../components/Bits';
import { Links } from '../components/Links';

export default function Host() {
  const t = useT();
  const nav = useNavigate();
  const { id = '' } = useParams();
  const creds = useMemo<Creds>(() => ({ role: 'host', meetingId: id }), [id]);
  const M = useMeeting(creds);
  const [cfg, setCfg] = useState<any>(null);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [mic, setMic] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [micErr, setMicErr] = useState('');
  const [showLinks, setShowLinks] = useState(false);
  const capture = useRef<Capture | null>(null);
  const browserAsr = useRef<{ stop(): void } | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { api('GET', '/api/config').then(setCfg).catch(() => {}); listMics().then(setMics); }, []);
  useEffect(() => { if (M.error === 'forbidden' || M.error === 'unauthorized') nav('/login'); }, [M.error]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: 'end' }); }, [M.transcript.length, M.partial]);

  const status = M.state?.status ?? M.data?.meeting.status;
  const live = status === 'live';
  const meeting = M.data?.meeting;

  // 会议进行中：开启收音；暂停/结束：关闭
  useEffect(() => {
    if (!live || !cfg) return;
    let cancelled = false;
    (async () => {
      try {
        setMicErr('');
        const cap = await startCapture(mic, (pcm) => M.socket.current?.emit('audio.chunk', pcm), (l) => setLevel(l));
        if (cancelled) { cap.stop(); return; }
        capture.current = cap;
        listMics().then(setMics); // 授权后才有设备名称
        if (cfg.asrMode === 'browser') {
          browserAsr.current = startBrowserAsr(meeting?.language ?? 'zh',
            (text, isFinal) => M.socket.current?.emit('transcript.client', { text, isFinal }), (e) => setMicErr(`ASR: ${e}`));
        }
      } catch (e: any) { setMicErr(String(e?.message ?? e)); }
    })();
    return () => { cancelled = true; capture.current?.stop(); capture.current = null; browserAsr.current?.stop(); browserAsr.current = null; setLevel(0); };
  }, [live, mic, cfg?.asrMode]);

  if (M.error) return <div className="page narrow"><p className="error">{M.error}</p><Link to="/meetings">{t('back')}</Link></div>;
  if (!M.data || !meeting) return <div className="page narrow muted">…</div>;

  const patch = (body: any) => api('PATCH', `/api/meetings/${id}`, body, creds).then(() => M.reload());
  const settings = { ...meeting.settings, ...(M.state ? { aiPaused: M.state.aiPaused, frequency: M.state.frequency, subtitles: M.state.subtitles } : {}) };
  const cardAct = {
    publish: (c: Card) => api('PATCH', `/api/cards/${c.id}`, { status: 'published' }, creds),
    hide: (c: Card) => api('PATCH', `/api/cards/${c.id}`, { status: 'hidden' }, creds),
    pin: (c: Card) => api('PATCH', `/api/cards/${c.id}`, { pinned: !c.pinned }, creds),
    focus: (c: Card) => api('PATCH', `/api/cards/${c.id}`, { focused: M.focusId !== c.id }, creds),
  };
  const { top, children } = cardStream(M.cards, (c) => ['published', 'hidden'].includes(c.status));
  const queue = Object.values(M.cards).filter((c) => ['pending_review', 'standby', 'ready'].includes(c.status));
  const metrics = M.data.metrics;

  const start = async () => {
    if (!meeting.started_at && !confirm(t('consent'))) return;
    await patch({ status: 'live', consent: true });
  };
  const end = async () => {
    if (!confirm(t('confirmEnd'))) return;
    await patch({ status: 'ended' });
    nav(`/m/${id}/summary`);
  };

  return (
    <div className="host">
      <header className="host-bar">
        <Link to="/meetings" className="link">←</Link>
        <strong className="title">{meeting.title}</strong>
        <span className="muted">{fmtDuration(M.state?.elapsedMs ?? meeting.elapsedMs)}</span>
        <AiStatus ai={M.ai} />
        {live && <span className="listening-badge">● {t('aiListeningBadge')}</span>}
        <span className="muted small">{M.online} {t('online')}</span>
        {!M.connected && <span className="error small">offline…</span>}
        <span className="grow" />
        <button className="link" onClick={() => setShowLinks(!showLinks)}>{t('code')} {meeting.join_code}</button>
        <LangSwitch />
      </header>
      {showLinks && <div className="links-pop"><Links meeting={meeting} qr={M.data.qr} /></div>}
      <Acks acks={M.acks} />

      <div className="host-grid">
        {/* 左：实时转写 */}
        <section className="col transcript-col">
          <h4>{t('transcript')}</h4>
          <div className="transcript">
            {M.transcript.map((s) => (
              <p key={s.id} className={`seg ${s.echo_of_card_id ? 'echo' : ''} ${s.is_command ? 'cmd' : ''}`}>
                <b>{s.speaker_name ?? s.speaker_label ?? '—'}</b> {s.text}
                {s.echo_of_card_id && <small> ↺ {M.cards[s.echo_of_card_id]?.title ?? 'card'}</small>}
              </p>
            ))}
            {M.partial && <p className="seg partial">{M.partial}</p>}
            <div ref={transcriptEnd} />
          </div>
          {live && <SimulateBox meetingId={id} creds={creds} />}
          {M.data.speakers?.length > 0 && <SpeakerRename meetingId={id} creds={creds} speakers={M.data.speakers} onDone={M.reload} />}
        </section>

        {/* 中：卡片流 + 审核队列 */}
        <section className="col cards-col">
          {queue.length > 0 && (
            <div className="queue">
              <h4>{t('reviewQueue')} / {t('standby')} / {t('ready')}</h4>
              {queue.map((c) => <CardView key={c.id} card={c} actions={{ host: cardAct }} />)}
            </div>
          )}
          {top.length === 0 && <p className="muted center pad">{live ? t('noCards') : t('waitingStart')}</p>}
          {top.map((c) => <CardView key={c.id} card={c} updates={children[c.id]} focused={M.focusId === c.id} fresh={!!M.fresh[c.id]} actions={{ host: cardAct }} />)}
        </section>

        {/* 右：控制区 */}
        <aside className="col control-col">
          <div className="controls">
            {!live && status !== 'ended' && <button className="primary big" onClick={start}>{meeting.started_at ? t('resume') : t('start')}</button>}
            {live && <button className="big" onClick={() => patch({ status: 'paused' })}>{t('pause')}</button>}
            {status !== 'ended' && meeting.started_at && <button className="danger" onClick={end}>{t('end')}</button>}
          </div>
          <label className="switch"><input type="checkbox" checked={!settings.aiPaused} onChange={(e) => patch({ settings: { aiPaused: !e.target.checked } })} /> {t('aiOn')}</label>
          <div>
            <div className="muted small">{t('frequency')}</div>
            <div className="seg-ctl">
              {(['quiet', 'standard', 'active'] as const).map((f) => (
                <button key={f} className={settings.frequency === f ? 'on' : ''} onClick={() => patch({ settings: { frequency: f } })}>{t(`freq.${f}`)}</button>
              ))}
            </div>
          </div>
          <label className="switch"><input type="checkbox" checked={!!settings.subtitles} onChange={(e) => patch({ settings: { subtitles: e.target.checked } })} /> {t('subtitles')}</label>
          <label className="switch"><input type="checkbox" checked={!!settings.minutesVisibleToGuests} onChange={(e) => patch({ settings: { minutesVisibleToGuests: e.target.checked } })} /> {t('minutesToGuests')}</label>
          {live && <button onClick={() => api('POST', `/api/meetings/${id}/summary-now`, {}, creds)}>{t('summaryNow')}</button>}
          {live && <button className="subtle" onClick={() => api('POST', `/api/meetings/${id}/judge-now`, {}, creds)}>{t('judgeNow')}</button>}
          <div>
            <div className="muted small">{t('mic')}</div>
            <select value={mic ?? ''} onChange={(e) => setMic(e.target.value || null)}>
              <option value="">Default</option>
              {mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <div className="meter"><i style={{ width: `${Math.min(100, level * 140)}%` }} /></div>
            {micErr && <p className="error small">{t('micDenied')}{micErr}</p>}
            {cfg?.asrMode === 'browser' && <p className="muted small">{t('browserAsrNote')}</p>}
            {cfg && <p className="muted small">{t('wakeHint')}：{[...cfg.wakeWords.zh, ...cfg.wakeWords.en].join(' / ')}</p>}
          </div>
          <RequestList requests={Object.values(M.requests)}
            onShow={(r) => api('PATCH', `/api/requests/${r.id}`, { action: 'show_now' }, creds)}
            onCancel={(r) => api('PATCH', `/api/requests/${r.id}`, { action: 'cancel' }, creds)} />
          {live && <AskBox placeholder={t('askAI')} onAsk={(text) => api('POST', `/api/meetings/${id}/requests`, { text }, creds)} />}
          {metrics && (
            <details className="metrics"><summary>{t('metrics')}</summary>
              <ul className="small">
                <li>{t('cards')}: {metrics.cardsShown}/{metrics.cardsTotal}</li>
                <li>{t('usefulRate')}: {metrics.usefulRate == null ? '—' : `${Math.round(metrics.usefulRate * 100)}%`}</li>
                <li>{t('echoes')}: {metrics.echoSegments}</li>
                <li>{t('reqDone')}: {metrics.requestsFulfilled}/{metrics.requests}</li>
              </ul>
              {M.lastJudge && <pre className="judge">{JSON.stringify({ should_card: M.lastJudge.should_card, type: M.lastJudge.card_type, score: M.lastJudge.value_score, reason: M.lastJudge.reason }, null, 1)}</pre>}
            </details>
          )}
          {M.data.materials?.length > 0 && <p className="muted small">{t('materials')}: {M.data.materials.map((x: any) => x.file_name ?? `${x.chars}字`).join('、')}</p>}
          <a className="link small" href={meeting.links.screen} target="_blank" rel="noreferrer">{t('screen')} ↗</a>
        </aside>
      </div>

      {/* 讨论模式（手机）：底部固定提问框 */}
      {live && <div className="mobile-ask"><AskBox placeholder={t('askAI')} onAsk={(text) => api('POST', `/api/meetings/${id}/requests`, { text }, creds)} /></div>}
    </div>
  );
}

function SimulateBox({ meetingId, creds }: { meetingId: string; creds: Creds }) {
  const t = useT();
  const [speaker, setSpeaker] = useState('S1');
  return (
    <details className="simulate">
      <summary className="muted small">{t('simulate')}</summary>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('text') as HTMLInputElement;
        const text = input.value.trim(); if (!text) return;
        input.value = '';
        await api('POST', `/api/meetings/${meetingId}/transcript`, { text, speaker }, creds);
      }}>
        <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>{['S1', 'S2', 'S3', 'S4'].map((s) => <option key={s}>{s}</option>)}</select>
        <input name="text" placeholder="…" autoComplete="off" />
        <button>{t('send')}</button>
      </form>
    </details>
  );
}

export function SpeakerRename({ meetingId, creds, speakers, onDone }: { meetingId: string; creds: Creds; speakers: { speaker_label: string; speaker_name: string | null }[]; onDone: () => void }) {
  const t = useT();
  return (
    <details className="speakers">
      <summary className="muted small">{t('renameSpeaker')}</summary>
      {speakers.map((s) => (
        <form key={s.speaker_label} className="row" onSubmit={async (e) => {
          e.preventDefault();
          const name = (e.currentTarget.elements.namedItem('n') as HTMLInputElement).value.trim();
          if (name) { await api('POST', `/api/meetings/${meetingId}/speakers`, { label: s.speaker_label, name }, creds); onDone(); }
        }}>
          <span className="muted">{s.speaker_label}</span>
          <input name="n" defaultValue={s.speaker_name ?? ''} placeholder={t('name')} />
          <button>{t('saveEdit')}</button>
        </form>
      ))}
    </details>
  );
}
