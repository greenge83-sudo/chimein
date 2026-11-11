import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Links } from '../components/Links';

const PRESETS = ['external', 'brainstorm', 'review', 'project', 'casual'] as const;

export default function NewMeeting() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState<string>('external');

  if (created) return (
    <div className="page narrow">
      <h2>{created.meeting.title}</h2>
      {err && <p className="error">{err}</p>}
      <Links meeting={created.meeting} qr={created.qr} />
      <Link className="btn primary big" to={`/m/${created.meeting.id}/host`}>{t('enterConsole')} →</Link>
    </div>
  );

  return (
    <div className="page narrow">
      <Link to="/meetings" className="link">← {t('back')}</Link>
      <h2>{t('newMeeting')}</h2>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true); setErr('');
        try {
          const r = await api('POST', '/api/meetings', {
            title: f.get('title'), preset, agenda: f.get('agenda') || null,
            counterparties: String(f.get('counterparties') ?? '').split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean),
            language: f.get('language'), card_language: f.get('card_language'), is_important: f.get('is_important') === 'on',
            background: f.get('background') || null,
          });
          if (file) {
            const fd = new FormData(); fd.append('file', file);
            await api('POST', `/api/meetings/${r.meeting.id}/materials`, fd).catch((e) => setErr(`${file.name}: ${e.code}`));
          }
          setCreated(r);
        } catch (e: any) { setErr(e.code ?? String(e)); } finally { setBusy(false); }
      }}>
        <label>{t('title')} *<input name="title" required maxLength={200} /></label>
        <fieldset className="presets"><legend>{t('preset')} *</legend>
          {PRESETS.map((p) => (
            <button type="button" key={p} className={preset === p ? 'chip on' : 'chip'} onClick={() => setPreset(p)}>{t(`preset.${p}` as any)}</button>
          ))}
        </fieldset>
        <label>{t('agenda')}<textarea name="agenda" rows={3} maxLength={5000} /></label>
        <label>{t('counterparties')}<input name="counterparties" maxLength={500} /></label>
        <label>{t('background')}<textarea name="background" rows={4} /></label>
        <label className="file">{t('uploadFile')}<input type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <div className="row wrap">
          <label>{t('meetingLang')}<select name="language" defaultValue="auto">
            <option value="auto">{t('lang.auto')}</option><option value="zh">{t('lang.zh')}</option><option value="en">{t('lang.en')}</option></select></label>
          <label>{t('cardLang')}<select name="card_language" defaultValue="zh">
            <option value="zh">{t('lang.zh')}</option><option value="en">{t('lang.en')}</option><option value="bilingual">{t('lang.bilingual')}</option></select></label>
        </div>
        <label className="check"><input type="checkbox" name="is_important" /> {t('important')}</label>
        {err && <p className="error">{err}</p>}
        <button className="primary big" disabled={busy}>{busy ? t('creating') : t('create')}</button>
      </form>
    </div>
  );
}
