/**
 * Official single-process PM2 config for Snail Pi Web server mode.
 *
 * Binds the Next backend to loopback and enables global access authentication
 * so an HTTPS reverse proxy (Caddy/Nginx) can terminate TLS in front.
 *
 * For direct LAN listen instead, replace args with:
 *   --server --no-open -H 0.0.0.0 -p 62666
 *
 * Multi-instance / cluster mode is not supported (auth state is single-writer).
 */
module.exports = {
  apps: [
    {
      name: "snail-pi-web",
      script: "bin/pi-web.js",
      args: "--server --no-open -H 127.0.0.1 -p 62666",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      env: {
        NODE_ENV: "production",
        PI_WEB_SERVER_MODE: "1",
        // This official profile is specifically for a trusted HTTPS reverse proxy.
        PI_WEB_TRUST_PROXY: "1",
      },
    },
  ],
};
