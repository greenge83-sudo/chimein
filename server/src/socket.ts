/** WebSocket 通道（需求 7.3）：房间 = meeting_id；连接时按身份加入主持人/参会者房间 */
import type { Server, Socket } from 'socket.io';
import { meetings, participants, users } from './db.js';
import { getRuntime } from './pipeline/runtime.js';
import { room, hostRoom, guestRoom, toHost } from './bus.js';

export function setupSocket(io: Server) {
  io.on('connection', (socket: Socket) => {
    const a = socket.handshake.auth as { meetingId?: string; hostToken?: string; participantToken?: string; screenKey?: string };
    const m = a.meetingId ? meetings.get(a.meetingId) : undefined;
    if (!m) { socket.emit('error.fatal', { error: 'not_found' }); socket.disconnect(true); return; }
    let role: 'host' | 'guest' | 'screen' | null = null;
    let pid: string | null = null;
    if (a.hostToken && users.bySession(a.hostToken)?.id === m.host_id) role = 'host';
    else if (a.participantToken) {
      const p = participants.byToken(a.participantToken);
      if (p && p.meeting_id === m.id) { role = 'guest'; pid = p.id; participants.touch(p.id); }
    } else if (a.screenKey && a.screenKey === m.screen_key) role = 'screen';
    if (!role) { socket.emit('error.fatal', { error: 'forbidden' }); socket.disconnect(true); return; }

    socket.join(room(m.id));
    socket.join(role === 'host' ? hostRoom(m.id) : guestRoom(m.id));
    const rt = getRuntime(m.id);
    rt?.broadcastState();
    const emitOnline = () => {
      const n = io.sockets.adapter.rooms.get(guestRoom(m.id))?.size ?? 0;
      toHost(m.id, 'participant.count', { online: n });
    };
    emitOnline();
    if (role === 'guest' && pid) {
      const p = participants.get(pid)!;
      toHost(m.id, 'participant.join', { id: p.id, nickname: p.nickname });
    }
    socket.on('disconnect', () => {
      if (pid) { participants.touch(pid); toHost(m.id, 'participant.leave', { id: pid }); }
      emitOnline();
    });

    if (role !== 'host') return;
    // 主持人 → 服务端：音频包（16kHz 单声道 PCM16，约 100ms 一包）
    socket.on('audio.chunk', (buf: Buffer | ArrayBuffer) => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer);
      getRuntime(m.id)?.onAudio(b);
    });
    // browser 识别模式：主持人浏览器识别后送来的确定结果
    socket.on('transcript.client', (p: { text: string; isFinal: boolean; lang?: string }) => {
      if (!p?.text) return;
      if (!p.isFinal) { toHost(m.id, 'transcript.partial', { text: p.text, speaker: null }); return; }
      getRuntime(m.id)?.onFinal({ text: String(p.text).slice(0, 2000), speaker: null, lang: p.lang ?? null, startMs: null, endMs: null }).catch(() => {});
    });
  });
}
