// pm2 process definition for the blobrogue authoritative game server. Runs BESIDE town on the
// same Hetzner box as its own app, fully isolated (own port, own logs, own /opt dir, mem cap).
//
// KEY CONSTRAINT: instances:1 + fork mode, NEVER cluster — worlds live in process memory, so a
// second instance would be a separate, inconsistent world. Horizontal scale later = more named
// apps on more ports (one per world-group), fronted by nginx routing — not pm2 cluster mode.
//
// Secrets are NOT stored here: reference process.env and keep real values in the box .env
// (chmod 600) or pm2's own env management. See .env.example for the required variable NAMES.

module.exports = {
  apps: [
    {
      name: "blobrogue-gs",
      // tsc (npm run build) emits with the shared src/ preserved; this is the compiled entry.
      script: "dist/server/src/main.js",
      cwd: "/opt/blobrogue-gs", // its own dir, not town's
      instances: 1, // ONE process — stateful in-memory worlds; do NOT cluster
      exec_mode: "fork", // NOT cluster mode
      max_memory_restart: "512M", // pm2 restarts if it exceeds this — can't starve town
      autorestart: true,
      env: {
        NODE_ENV: "production",
        PORT: "8090",
        GS_HOST: "127.0.0.1",
        GS_WS_PATH: "/ws",
        // GS_AUTH_SECRET + CONVEX_URL come from the box .env (never committed). Do not inline
        // secret values in this file if it lives in git.
      },
      error_file: "/var/log/blobrogue-gs/err.log",
      out_file: "/var/log/blobrogue-gs/out.log",
      time: true,
    },
  ],
};
