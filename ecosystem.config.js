module.exports = {
  apps: [
    {
      name: 'wa-summarizer',
      script: 'src/index.js',
      instances: 1, // MUST be 1 — a WhatsApp session can't be shared across processes
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '700M',
      restart_delay: 5000,
      max_restarts: 50,
      env: { NODE_ENV: 'production' },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
