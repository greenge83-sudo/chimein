import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { meetings } from './db.js';
import { setIO } from './bus.js';
import { apiRoutes } from './routes/api.js';
import { setupSocket } from './socket.js';
import { shutdownAll } from './pipeline/runtime.js';

const app = Fastify({ logger: { level: config.isProd ? 'info' : 'warn' }, bodyLimit: 2 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request', issues: err.issues });
  app.log.error(err);
  reply.code((err as any).statusCode ?? 500).send({ error: (err as any).statusCode ? (err as Error).message : 'internal_error' });
});

await app.register(apiRoutes);
app.get('/healthz', async () => ({ ok: true, region: config.region }));

// 生产环境：同一服务直接托管前端构建产物
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist');
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io')) return reply.code(404).send({ error: 'not_found' });
    return reply.sendFile('index.html');
  });
}

const io = new Server(app.server, { cors: { origin: true }, maxHttpBufferSize: 1e6 });
setIO(io);
setupSocket(io);

// 原始录音 14 天后自动删除（需求 F-11）
function purgeAudio() {
  for (const m of meetings.expiredAudio()) {
    try { fs.unlinkSync(path.join(config.dataDir, m.audio_url!)); } catch { /* already gone */ }
    meetings.update(m.id, { audio_url: null, audio_expires_at: null });
    console.info('[retention] deleted audio for', m.id);
  }
}
purgeAudio();
setInterval(purgeAudio, 3600_000).unref();

// 服务重启时，进行中的会议保持 live；暂停状态由运行时恢复
const close = async () => { shutdownAll(); await app.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`ChimeIn server on :${config.port} (region=${config.region}, llm=${config.llm.judge.provider}/${config.llm.generate.provider}, search=${config.search.provider}, asr=${config.asr.provider})`);
