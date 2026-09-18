// pm2 process file — jalankan: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'tennis-game',
      script: 'server.js',
      cwd: '/var/www/tennis-game',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: '2000',
        // DB wajib di disk lokal (jangan pindah ke flashdisk/network).
        DB_PATH: '/var/www/tennis-game/tennis.db'
      }
    }
  ]
};
