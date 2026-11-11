import { useT, useLang, setLang } from '../lib/i18n';
import type { Ack } from '../lib/useMeeting';
import type { CardRequest } from '../lib/api';

export function AiStatus({ ai, big }: { ai: { state: string; topic: string | null }; big?: boolean }) {
  const t = useT();
  const k = (`ai.${ai.state}` as any);
  return (
    <span className={`ai-status ai-${ai.state} ${big ? 'big' : ''}`} role="status">
      <i className="dot" />{t(k)}
      {ai.state === 'thinking' && ai.topic && <span className="topic">· {t('checking')}：{ai.topic}</span>}
    </span>
  );
}

export function Acks({ acks, onCancel }: { acks: Ack[]; onCancel?: (id: string) => void }) {
  const t = useT();
  if (!acks.length) return null;
  return (
    <div className="acks">
      {acks.map((a) => (
        <div key={a.id + a.at} className="ack">
          {t('received')}：{a.summary}
          {a.needsClarification && <small> · {t('clarify')}</small>}
          {onCancel && <button className="link" onClick={() => onCancel(a.id)}>{t('cancel')}</button>}
        </div>
      ))}
    </div>
  );
}

export function RequestList({ requests, onCancel, onShow, canManage }: {
  requests: CardRequest[]; onCancel?: (r: CardRequest) => void; onShow?: (r: CardRequest) => void; canManage?: (r: CardRequest) => boolean;
}) {
  const t = useT();
  const active = requests.filter((r) => !['published', 'cancelled'].includes(r.status) || Date.now() - r.created_at < 60_000);
  if (!active.length) return null;
  return (
    <section className="requests">
      <h4>{t('requests')} <span className="count">{active.filter((r) => !['published', 'cancelled', 'failed'].includes(r.status)).length}</span></h4>
      <ul>
        {active.sort((a, b) => b.created_at - a.created_at).map((r) => (
          <li key={r.id}>
            <span className={`req-status rs-${r.status}`}>{t(`req.${r.status}` as any)}</span>
            <span className="req-text">{r.parsed_intent?.request_summary ?? r.request_text}
              {r.mode === 'on_topic' && r.topic && <em> · #{r.topic}</em>}
              {r.mode === 'at_time' && r.due_at && <em> · {new Date(r.due_at).toLocaleTimeString().slice(0, 5)}</em>}
            </span>
            {(canManage?.(r) ?? true) && !['published', 'cancelled', 'failed'].includes(r.status) && <span className="req-actions">
              {onShow && <button className="link" onClick={() => onShow(r)}>{t('showNow')}</button>}
              {onCancel && <button className="link" onClick={() => onCancel(r)}>{t('cancel')}</button>}
            </span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LangSwitch() {
  const l = useLang();
  return <button className="lang-switch" onClick={() => setLang(l === 'zh' ? 'en' : 'zh')}>{l === 'zh' ? 'EN' : '中'}</button>;
}

export function AskBox({ onAsk, placeholder }: { onAsk: (text: string) => Promise<void>; placeholder: string }) {
  const t = useT();
  return (
    <form className="ask-box" onSubmit={async (e) => {
      e.preventDefault();
      const f = e.currentTarget; const input = f.elements.namedItem('q') as HTMLInputElement;
      const v = input.value.trim(); if (v.length < 2) return;
      input.value = ''; await onAsk(v);
    }}>
      <input name="q" placeholder={placeholder} autoComplete="off" maxLength={500} />
      <button type="submit" className="primary">{t('send')}</button>
    </form>
  );
}
