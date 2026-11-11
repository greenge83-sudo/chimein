/**
 * 收音：getUserMedia → AudioWorklet 重采样为 16kHz 单声道 PCM16 → 约 100ms 一包回调（需求 6.1 第 1 步）。
 * 开启回声消除和降噪；手机收音时调用屏幕常亮接口。
 */
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.acc = []; this.pos = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let level = 0;
    for (let i = 0; i < ch.length; i++) level = Math.max(level, Math.abs(ch[i]));
    for (; this.pos < ch.length; this.pos += this.ratio) this.acc.push(ch[Math.floor(this.pos)]);
    this.pos -= ch.length;
    if (this.acc.length >= 1600) {
      const out = new Int16Array(this.acc.length);
      for (let i = 0; i < this.acc.length; i++) { const s = Math.max(-1, Math.min(1, this.acc[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      this.port.postMessage({ pcm: out.buffer, level }, [out.buffer]);
      this.acc = [];
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);
`;

export interface Capture { stop(): void }

export async function listMics() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
  } catch { return []; }
}

export async function startCapture(deviceId: string | null, onChunk: (pcm: ArrayBuffer) => void, onLevel: (l: number) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm16');
  node.port.onmessage = (e) => { onChunk(e.data.pcm); onLevel(e.data.level); };
  src.connect(node);
  const wake = await requestWakeLock();
  return {
    stop() { node.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close(); wake?.release().catch(() => {}); },
  };
}

export async function requestWakeLock(): Promise<{ release(): Promise<void> } | null> {
  try { return await (navigator as any).wakeLock?.request('screen'); } catch { return null; }
}

/** 浏览器自带识别（试用模式，无需 ASR Key；Chrome 可用，无说话人分离） */
export function startBrowserAsr(lang: string, onResult: (text: string, isFinal: boolean) => void, onError: (e: string) => void) {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) { onError('SpeechRecognition not supported'); return null; }
  let stopped = false;
  const rec = new SR();
  rec.lang = lang === 'en' ? 'en-US' : 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) onResult(e.results[i][0].transcript, e.results[i].isFinal);
  };
  rec.onerror = (e: any) => { if (e.error !== 'no-speech' && e.error !== 'aborted') onError(e.error); };
  rec.onend = () => { if (!stopped) try { rec.start(); } catch { /* already started */ } };
  rec.start();
  return { stop() { stopped = true; rec.stop(); } };
}
