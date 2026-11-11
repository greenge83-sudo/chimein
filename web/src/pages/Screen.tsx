import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { fmtDuration, type Creds } from '../lib/api';
import { useT } from '../lib/i18n';
import { cardStream, useMeeting } from '../lib/useMeeting';
import { CardView, TypeBadge } from '../components/CardView';
import { AiStatus } from '../components/Bits';

/** 公共大屏：只读；1920×1080，正文字号 ≥ 32px；新卡平滑滑入，不弹窗不发声 */
export default function Screen() {
  const t = useT();
  const { id = '' } = useParams();
  const [sp] = useSearchParams();
  const creds = useMemo<Creds>(() => ({ role: 'screen', meetingId: id, screenKey: sp.get('k') ?? '' }), [id, sp]);
  const M = useMeeting(creds);
  if (M.error) return <div className="screen"><p className="error pad">{M.error}</p></div>;
  if (!M.data) return <div className="screen" />;
  const meeting = M.data.meeting;
  const { top, children } = cardStream(M.cards, (c) => c.status === 'published');
  // 最新一张卡居中（迭代卡会把原卡顶上来）；主持人聚焦时显示聚焦卡；置顶卡不抢中心位
  const byRecent = [...top].sort((a, b) => {
    const k = (c: typeof a) => Math.max(c.published_at ?? 0, ...(children[c.id] ?? []).map((x) => x.published_at ?? 0));
    return k(b) - k(a);
  });
  const focus = M.focusId ? M.cards[M.focusId] : null;
  const main = focus ?? byRecent[0];
  const status = M.state?.status ?? meeting.status;

  return (
    <div className={`screen ${focus ? 'focus-mode' : ''}`}>
      <header className="screen-bar">
        <strong>{M.state?.title ?? meeting.title}</strong>
        <span>{fmtDuration(M.state?.elapsedMs ?? meeting.elapsedMs)}</span>
        <AiStatus ai={M.ai} big />
        {status === 'live' && <span className="listening-badge">● {t('aiListeningBadge')}</span>}
        {!M.connected && <span className="error">offline…</span>}
      </header>
      <main className="screen-main">
        <div className="screen-center">
          {main ? <CardView key={main.id + (children[main.id]?.length ?? 0)} card={main} updates={children[main.id]} big fresh /> :
            <p className="screen-empty">{status === 'ended' ? t('ended') : status === 'live' ? t('noCards') : t('waitingStart')}</p>}
        </div>
        {!focus && byRecent.length > 1 && (
          <ol className="timeline">
            {byRecent.slice(1, 9).map((c) => (
              <li key={c.id}><TypeBadge type={c.type} /> {c.title}</li>
            ))}
          </ol>
        )}
      </main>
      {M.acks.length > 0 && <div className="screen-ack">{t('received')}：{M.acks.at(-1)!.summary}</div>}
      {M.state?.subtitles && M.subtitle && <div className="subtitle">{M.subtitle}</div>}
      <div className="join-corner">
        {M.data.qr && <img src={M.data.qr} alt="QR" />}
        <div>{t('scanToJoin')}<br /><b>{meeting.join_code}</b></div>
      </div>
    </div>
  );
}
