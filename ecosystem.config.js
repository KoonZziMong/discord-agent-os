module.exports = {
  apps: [
    {
      name: 'discord-ai-team',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '500M',
      error_file: 'logs/error.log',
      out_file: 'logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
