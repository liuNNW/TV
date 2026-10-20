/**
 * PM2 托管配置。
 *
 * 单实例 fork 模式：项目里有内存态转码任务、分类缓存和「同一时间只允许一个」的更新任务，
 * 不能用 cluster 多实例（会各跑一份、抢端口、共享不了内存状态）。
 *
 * 启动：
 *   pm2 startOrReload ecosystem.config.cjs --update-env
 *   pm2 save
 */
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'movie-player',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Web 一键更新时进程会主动 exit，交给 PM2 重新拉起；
      // 留 1 秒让 8848 端口彻底释放，避免新旧进程抢端口。
      restart_delay: 1000,
      max_restarts: 20,
      min_uptime: '10s',
      max_memory_restart: '1G',
      kill_timeout: 5000,
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: process.env.HOST || '0.0.0.0',
        PORT: process.env.PORT || '8848',
        DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
        // updater 用它识别自己的 PM2 应用名
        PM2_APP_NAME: 'movie-player',
      },
    },
  ],
};
