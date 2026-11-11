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

export function Links({ meeting, qr }: { meeting: any; qr?: string }) {
  const t = useT();
  return (
    <div className="links">
      {qr && <img className="qr" src={qr} alt="QR" />}
      <div className="code-big">{t('code')}：<b>{meeting.join_code}</b></div>
      <CopyRow label={t('joinLink')} value={meeting.links.join} />
      <CopyRow label={t('screenLink')} value={meeting.links.screen} href={meeting.links.screen} />
      <CopyRow label={t('hostLink')} value={meeting.links.host} />
    </div>
  );
}
