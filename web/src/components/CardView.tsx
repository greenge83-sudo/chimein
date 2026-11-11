import { useState } from 'react';
import type { Card } from '../lib/api';
import { useT, getLang } from '../lib/i18n';

export const TYPE_META: Record<string, { zh: string; en: string; color: string; icon: string }> = {
  knowledge: { zh: '知识', en: 'Concept', color: 'var(--c-knowledge)', icon: 'i' },
  data_reference: { zh: '数据', en: 'Data', color: 'var(--c-data)', icon: '#' },
  fact_check: { zh: '核对', en: 'Fact check', color: 'var(--c-fact)', icon: '✓' },
  entity_brief: { zh: '速览', en: 'Profile', color: 'var(--c-entity)', icon: '◎' },
  case_study: { zh: '案例', en: 'Case', color: 'var(--c-case)', icon: '◆' },
  inspiration: { zh: '追问', en: 'Question', color: 'var(--c-insp)', icon: '?' },
  discussion_summary: { zh: '小结', en: 'Summary', color: 'var(--c-summary)', icon: '≡' },
  answer: { zh: '问答', en: 'Answer', color: 'var(--c-answer)', icon: 'A' },
  iteration: { zh: '更新', en: 'Update', color: 'var(--c-iter)', icon: '+' },
};

export function TypeBadge({ type }: { type: string }) {
  const m = TYPE_META[type] ?? TYPE_META.knowledge;
  return <span className="type-badge" style={{ ['--tc' as any]: m.color }}><b>{m.icon}</b>{getLang() === 'zh' ? m.zh : m.en}</span>;
}

export interface CardActions {
  react?: (c: Card, kind: 'useful' | 'irrelevant' | 'saved', on: boolean) => void;
  deepdive?: (c: Card) => void;
  host?: { publish: (c: Card) => void; hide: (c: Card) => void; pin: (c: Card) => void; focus: (c: Card) => void };
}

export function CardView({ card, updates = [], mine, actions, big, fresh, focused }: {
  card: Card; updates?: Card[]; mine?: Set<string>; actions?: CardActions; big?: boolean; fresh?: boolean; focused?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const has = (k: string) => mine?.has(`${card.id}:${k}`) ?? false;
  const statusTag = card.status !== 'published' ? <span className={`status-tag s-${card.status}`}>{card.status === 'pending_review' ? t('reviewQueue') : card.status === 'standby' ? t('standby') : card.status === 'ready' ? t('ready') : card.status}</span> : null;
  const sources = [...card.sources, ...updates.flatMap((u) => u.sources)];
  return (
    <article className={`card ${big ? 'card-big' : ''} ${fresh ? 'card-fresh' : ''} ${focused ? 'card-focused' : ''} ${card.status === 'hidden' ? 'card-hidden' : ''}`}
      style={{ ['--tc' as any]: (TYPE_META[card.type] ?? TYPE_META.knowledge).color }}>
      <header className="card-head">
        <TypeBadge type={card.type} />
        {card.pinned && <span className="pin">📌</span>}
        {statusTag}
        {card.asked_by && <span className="asked">{t('askedBy')}：{card.asked_by}</span>}
      </header>
      <h3 className="card-title">{card.title}</h3>
      <p className="card-body">{card.body}</p>
      {card.bullets.length > 0 && <ul className="card-bullets">{card.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      {updates.map((u) => (
        <div key={u.id} className="card-update">
          <div className="update-label">{t('update')}{u.increment_text ? ` · ${u.increment_text}` : ''}</div>
          <p>{u.body}</p>
          {u.bullets.length > 0 && <ul className="card-bullets">{u.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
        </div>
      ))}
      {!big && card.trigger_quote && card.origin === 'auto' && <p className="trigger">{t('because')}："{card.trigger_quote}"</p>}
      {!big && sources.length > 0 && (
        <div className="sources">
          <button className="link" onClick={() => setOpen(!open)}>{t('sources')} ({sources.length}) {open ? '▴' : '▾'}</button>
          {open && <ol>{sources.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a></li>)}</ol>}
        </div>
      )}
      {big && sources.length > 0 && <p className="sources-inline">{t('sources')}：{sources.slice(0, 2).map((s) => s.title).join('；')}</p>}
      {(actions?.react || actions?.deepdive || actions?.host) && (
        <footer className="card-actions">
          {actions.react && card.status === 'published' && <>
            <button className={has('useful') ? 'on' : ''} onClick={() => actions.react!(card, 'useful', !has('useful'))}>👍 {t('useful')} {card.reactions?.useful || ''}</button>
            <button className={has('irrelevant') ? 'on' : ''} onClick={() => actions.react!(card, 'irrelevant', !has('irrelevant'))}>👎 {t('irrelevant')}</button>
            <button className={has('saved') ? 'on' : ''} onClick={() => actions.react!(card, 'saved', !has('saved'))}>★ {has('saved') ? t('saved') : t('save')}</button>
          </>}
          {actions.deepdive && card.status === 'published' && <button onClick={() => actions.deepdive!(card)}>⤵ {t('deepdive')}</button>}
          {actions.host && <>
            {card.status !== 'published' && <button className="primary" onClick={() => actions.host!.publish(card)}>{card.status === 'hidden' ? t('unhide') : t('approve')}</button>}
            {card.status === 'published' && <button onClick={() => actions.host!.hide(card)}>{t('hide')}</button>}
            {card.status === 'published' && <button onClick={() => actions.host!.pin(card)}>{card.pinned ? t('unpin') : t('pin')}</button>}
            {card.status === 'published' && <button onClick={() => actions.host!.focus(card)}>{focused ? t('unfocus') : t('focus')}</button>}
          </>}
        </footer>
      )}
    </article>
  );
}
