/**
 * 流式语音识别适配层（需求 6.1 第 2 步）。服务端接收主持人浏览器发来的 16kHz 单声道 PCM，
 * 转发给 ASR 供应商，回调 partial / final。browser 模式下由主持人浏览器自己识别，服务端不建会话。
 */
import WebSocket from 'ws';
import { config } from '../../config.js';

export interface FinalSegment { text: string; speaker: string | null; lang: string | null; startMs: number | null; endMs: number | null }
export interface AsrCallbacks {
  onPartial(text: string, speaker: string | null): void;
  onFinal(seg: FinalSegment): void;
  onError(err: Error): void;
}
export interface AsrSession { push(pcm: Buffer): void; close(): void }

export function asrMode(): 'server' | 'browser' | 'none' {
  if (config.asr.provider === 'soniox' || config.asr.provider === 'assemblyai') return 'server';
  if (config.asr.provider === 'browser') return 'browser';
  return 'none';
}

export function createAsrSession(opts: { language: string; hints: string[] }, cb: AsrCallbacks): AsrSession | null {
  if (config.asr.provider === 'soniox') return soniox(opts, cb);
  if (config.asr.provider === 'assemblyai') return assemblyai(opts, cb);
  return null;
}

/** 断线自动重连 + 本地缓存音频，恢复后补传（需求九 稳定性） */
function resilient(open: () => WebSocket, onOpen: (ws: WebSocket) => void, onMsg: (data: any) => void, cb: AsrCallbacks, encode = (b: Buffer) => b as any): AsrSession {
  let ws: WebSocket | null = null;
  let closed = false;
  let buffer: Buffer[] = [];
  let retries = 0;
  const connect = () => {
    ws = open();
    ws.on('open', () => {
      retries = 0;
      onOpen(ws!);
      for (const b of buffer) ws!.send(encode(b));
      buffer = [];
    });
    ws.on('message', (d) => { try { onMsg(JSON.parse(d.toString())); } catch (e) { cb.onError(e as Error); } });
    ws.on('error', (e) => cb.onError(e));
    ws.on('close', () => {
      if (closed) return;
      const delay = Math.min(10_000, 500 * 2 ** retries++);
      setTimeout(connect, delay);
    });
  };
  connect();
  return {
    push(pcm) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(encode(pcm));
      else { buffer.push(pcm); if (buffer.length > 3000) buffer.shift(); } // 最多缓存约 5 分钟
    },
    close() { closed = true; try { ws?.close(); } catch { /* ignore */ } },
  };
}

function soniox(opts: { language: string; hints: string[] }, cb: AsrCallbacks): AsrSession {
  let pending: { text: string; speaker: string | null; lang: string | null; start: number | null; end: number | null } | null = null;
  const flush = () => {
    if (pending && pending.text.trim()) cb.onFinal({ text: pending.text.trim(), speaker: pending.speaker, lang: pending.lang, startMs: pending.start, endMs: pending.end });
    pending = null;
  };
  return resilient(
    () => new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket'),
    (ws) => ws.send(JSON.stringify({
      api_key: config.asr.sonioxKey,
      model: process.env.SONIOX_MODEL || 'stt-rt-v3',
      audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
      language_hints: opts.language === 'auto' ? ['zh', 'en'] : [opts.language],
      enable_speaker_diarization: true, enable_language_identification: true, enable_endpoint_detection: true,
      context: opts.hints.join(', ').slice(0, 2000),
    })),
    (msg) => {
      if (msg.error_code) return cb.onError(new Error(`soniox ${msg.error_code}: ${msg.error_message}`));
      let partial = '';
      for (const t of msg.tokens ?? []) {
        if (t.text === '<end>') { flush(); continue; }
        const speaker = t.speaker != null ? `S${t.speaker}` : null;
        if (t.is_final) {
          if (pending && speaker && pending.speaker && speaker !== pending.speaker) flush();
          pending ??= { text: '', speaker, lang: t.language ?? null, start: t.start_ms ?? null, end: null };
          pending.text += t.text; pending.end = t.end_ms ?? pending.end;
        } else partial += t.text;
      }
      const preview = (pending?.text ?? '') + partial;
      if (preview.trim()) cb.onPartial(preview, pending?.speaker ?? null);
      if (msg.finished) flush();
    },
    cb,
  );
}

function assemblyai(opts: { language: string; hints: string[] }, cb: AsrCallbacks): AsrSession {
  const params = new URLSearchParams({
    sample_rate: '16000', encoding: 'pcm_s16le', format_turns: 'true',
    speech_model: process.env.ASSEMBLYAI_SPEECH_MODEL || 'universal-streaming-multilingual',
  });
  if (opts.hints.length) params.set('keyterms_prompt', JSON.stringify(opts.hints.slice(0, 100)));
  return resilient(
    () => new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`, { headers: { Authorization: config.asr.assemblyaiKey } }),
    () => {},
    (msg) => {
      if (msg.type === 'Turn') {
        const speaker = msg.speaker_label ?? (msg.words?.[0]?.speaker ?? null);
        if (msg.end_of_turn && msg.turn_is_formatted) {
          cb.onFinal({ text: msg.transcript, speaker: speaker ? `S${speaker}` : null, lang: msg.language_code ?? null,
            startMs: msg.words?.[0]?.start ?? null, endMs: msg.words?.at?.(-1)?.end ?? null });
        } else if (!msg.end_of_turn) cb.onPartial(msg.transcript, speaker);
      } else if (msg.type === 'Error' || msg.error) cb.onError(new Error(`assemblyai: ${msg.error ?? JSON.stringify(msg)}`));
    },
    cb,
  );
}
