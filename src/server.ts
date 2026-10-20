/**
 * 服务入口（前后端一体，直接 node dist/server.js 即可运行）。
 *
 * 默认监听 0.0.0.0:8848，方便 NAS 局域网访问；
 * 只在本机跑时可用环境变量 HOST=127.0.0.1 收回。
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HOST, PORT, SOURCES } from './config.js';
import { router } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const app = express();

// Express 4 不会捕获 async 路由的异常，一次未处理的写入失败就会把整个进程打崩
// （实测：data 文件带只读属性时 saveHistory 的 rename 抛 EPERM → 服务退出）。
// 这里兜底记日志，不让瞬时错误杀死常驻服务。
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

// SSH 断开时终端会发 SIGHUP，默认行为是进程退出 —— 直接 node 启动时
// 「关掉 SSH 服务就没了」就是这个信号造成的。忽略它，服务才能活过断连。
process.on('SIGHUP', () => {
  console.log('[server] 收到 SIGHUP（SSH 断开），继续运行');
});

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// 静态前端
app.use(express.static(publicDir));

// API
app.use('/api', router);

// 兜底：未匹配的 API 返回 JSON 404，其余交给首页
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' });
});

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  影视播放站已启动');
  console.log(`  地址: http://${HOST}:${PORT}`);
  console.log(`  片源: ${SOURCES.map((s) => `${s.name}(${s.id})`).join('、')}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。`);
    console.error(`  换个端口再启动，例如：  $env:PORT=8849; npm start\n`);
  } else {
    console.error('\n  启动失败:', err.message, '\n');
  }
  process.exit(1);
});

// 优雅退出，避免 tsx watch 重启时端口残留
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
