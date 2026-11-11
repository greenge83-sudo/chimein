import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, auth, type Card, type Creds } from '../lib/api';
import { useT } from '../lib/i18n';
import { cardStream, useMeeting } from '../lib/useMeeting';
import { CardView } from '../components/CardView';
import { Acks, AiStatus, AskBox, LangSwitch, RequestList } from '../components/Bits';

export default function Participant() {
  const { id = '' } = useParams();
  const [joined, setJoined] = useState(!!auth.participantToken(id) || !!auth.hostToken());
  if (!joined) return <JoinForm meetingId={id} onJoined={() => setJoined(true)} />;
  return <Room meetingId={id} onKicked={() => setJoined(false)} />;
}

function JoinForm({ meetingId, onJoined }: { meetingId: string; onJoined: () => void }) {
  const t = useT();
  const [err, setErr] = useState('');
  return (
    <div className="page narrow">
      <div className="top-right"><LangSwitch /></div>
      <h1 className="brand">{t('appName')}</h1>
      <h2>{t('joinTitle')}</h2>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        try {
          const r = await api('POST', '/api/join', { code: String(f.get('code')).trim(), nickname: f.get('nickname'), meetingId });
          auth.setParticipantToken(r.meetingId, r.participantToken);
          onJoined();
        } catch (e: any) { setErr(e.code === 'invalid_code' ? t('invalidCode') : e.code); }
      }}>
        <label>{t('code')}<input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoFocus /></label>
        <label>{t('nickname')}<input name="nickname" maxLength={30} required /></label>
        {err && <p className="error">{err}</p>}
        <button className="primary big">{t('join')}</button>
      </form>
    </div>
  );
}

function Room({ meetingId, onKicked }: { meetingId: string; onKicked: () => void }) {
  const t = useT();
  // 主持人用手机打开参会者链接时，也能以主持人身份看卡
  const role = auth.participantToken(meetingId) ? 'guest' : 'host';
  const creds = useMemo<Creds>(() => ({ role, meetingId }), [meetingId, role]);
  const M = useMeeting(creds);
  const [mine, setMine] = useState<Set<string> | null>(null);
  const myReactions = useMemo(() => mine ?? new Set<string>((M.data?.myReactions ?? []).map((r: any) => `${r.card_id}:${r.kind}`)), [mine, M.data]);
  if (M.error === 'forbidden') { onKicked(); return null; }
  if (M.error) return <div className="page narrow"><p className="error">{M.error}</p></div>;
  if (!M.data) return <div className="page narrow muted">…</div>;

  const meeting = M.data.meeting;
  const status = M.state?.status ?? meeting.status;
  const { top, children } = cardStream(M.cards, (c) => c.status === 'published');
  const react = async (c: Card, kind: 'useful' | 'irrelevant' | 'saved', on: boolean) => {
    const next = new Set(myReactions);
    if (on) { next.add(`${c.id}:${kind}`); if (kind !== 'saved') next.delete(`${c.id}:${kind === 'useful' ? 'irrelevant' : 'useful'}`); }
    else next.delete(`${c.id}:${kind}`);
    setMine(next);
    await api('POST', `/api/cards/${c.id}/reactions`, { kind, on }, creds).catch(() => {});
  };
  const myName = M.data.me?.nickname;

  return (
    <div className="participant">
      <header className="p-bar">
        <strong className="title">{M.state?.title ?? meeting.title}</strong>
        <AiStatus ai={M.ai} />
        <LangSwitch />
      </header>
      {status === 'live' && <div className="listening-strip">● {t('aiListeningBadge')}</div>}
      {!M.connected && <div className="error small center">offline…</div>}
      <Acks acks={M.acks} onCancel={(rid) => api('PATCH', `/api/requests/${rid}`, { action: 'cancel' }, creds).catch(() => {})} />
      <RequestList requests={Object.values(M.requests)} canManage={(r) => role === 'host' || r.requested_by === myName}
        onCancel={(r) => api('PATCH', `/api/requests/${r.id}`, { action: 'cancel' }, creds)} />
      <main className="p-stream">
        {status === 'ended' && (
          <p className="center pad">{t('ended')} · <Link to={`/m/${meetingId}/summary`}>{t('viewSummary')}</Link></p>
        )}
        {top.length === 0 && status !== 'ended' && <p className="muted center pad">{status === 'live' ? t('noCards') : t('waitingStart')}</p>}
        {top.map((c) => (
          <CardView key={c.id} card={c} updates={children[c.id]} mine={myReactions} fresh={!!M.fresh[c.id]} focused={M.focusId === c.id}
            actions={{ react, deepdive: status === 'live' ? (c) => api('POST', `/api/cards/${c.id}/deepdive`, {}, creds) : undefined }} />
        ))}
      </main>
      {status === 'live' && (
        <div className="p-ask"><AskBox placeholder={t('askAI')} onAsk={async (text) => {
          // 带"等会儿/讨论到…时/几分钟后"的是预约，其余按提问立即回答
          const isRequest = /(等会|等一下|稍后|待会|讨论到|说到|聊到|分钟后|分钟之后|结束前|later|when we|in \d+ min|before the end)/i.test(text);
          await api('POST', `/api/meetings/${meetingId}/${isRequest ? 'requests' : 'questions'}`, { text }, creds);
        }} /></div>
      )}
    </div>
  );
}
