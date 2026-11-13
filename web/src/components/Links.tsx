import { useState } from 'react';
import { useT } from '../lib/i18n';

function CopyRow({ label, value, href }: { label: string; value: string; href?: string }) {
  const t = useT();
  const [ok, setOk] = useState(false);
  return (
    <div className="copy-row">
      <div className="muted small">{label}</div>
      <div className="row">
        <code>{value}</code>
        <button onClick={() => { navigator.clipboard?.writeText(value); setOk(true); setTimeout(() => setOk(false), 1500); }}>{ok ? t('copied') : t('copy')}</button>
        {href && <a className="btn" href={href} target="_blank" rel="noreferrer">{t('open')}</a>}
      </div>
    </div>
  );
}

/** 手机优先：二维码 + 口令给同场成员；大屏链接收进"会议室有大屏？"里 */
export function Links({ meeting, qr }: { meeting: any; qr?: string }) {
  const t = useT();
  const ourSide = meeting.audience === 'our_side';
  return (
    <div className="links">
      {ourSide && <p className="warn">🔒 {t('ourSideWarn')}</p>}
      <div className="muted small center">{t('phoneSync')}</div>
      {qr && <img className="qr" src={qr} alt="QR" />}
      <div className="code-big">{t('code')}：<b>{meeting.join_code}</b></div>
      <CopyRow label={t('joinLink')} value={meeting.links.join} />
      <CopyRow label={t('hostLink')} value={meeting.links.host} />
      <details>
        <summary className="muted small">{t('hasScreen')}</summary>
        <CopyRow label={t('screenLink')} value={meeting.links.screen} href={meeting.links.screen} />
      </details>
    </div>
  );
}
