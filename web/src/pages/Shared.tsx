import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Card } from '../lib/api';
import { useT } from '../lib/i18n';
import { CardView } from '../components/CardView';
import { LangSwitch } from '../components/Bits';
import { MinutesView } from './Summary';

/** 只读分享页：只含已上屏卡片，不含录音和转写 */
export default function Shared() {
  const t = useT();
  const { token = '' } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('GET', `/api/share/${token}`).then(setD).catch((e) => setErr(e.code)); }, [token]);
  if (err) return <div className="page narrow"><p className="error">{err}</p></div>;
  if (!d) return <div className="page narrow muted">…</div>;
  return (
    <div className="page summary">
      <header className="bar no-print"><span className="brand small">{t('appName')}</span><LangSwitch /></header>
      <h1>{d.meeting.title}</h1>
      <p className="muted">{d.meeting.started_at && new Date(d.meeting.started_at).toLocaleString()}{d.meeting.counterparties.length > 0 && ` · ${d.meeting.counterparties.join(' / ')}`}</p>
      {d.minutes?.status === 'ready' && <section><h2>{t('minutes')}</h2><MinutesView mi={d.minutes} /></section>}
      {d.cards.length > 0 && <section><h2>{t('cardReview')}</h2>
        <div className="card-grid">{d.cards.filter((c: Card) => !(c.type === 'iteration' && c.parent_card_id)).map((c: Card) => (
          <CardView key={c.id} card={c} updates={d.cards.filter((x: Card) => x.parent_card_id === c.id && x.type === 'iteration')} />
        ))}</div></section>}
    </div>
  );
}
