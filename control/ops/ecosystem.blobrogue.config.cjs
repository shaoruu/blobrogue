// pm2 ecosystem for the release-symlink layout: blobrogue-gs (prod), blobrogue-gs-staging, and
// blobrogue-control — three SEPARATE fork apps, each instances:1, own port, own logs, own memory
// cap. Town is NOT defined here and is never touched. Each app's `cwd` is a release symlink so a
// deploy is an atomic symlink swap + reload, never an in-place file edit.
//
// Layout (see the control-plane spec §4.1):
//   /opt/blobrogue-gs/current  -> releases/<id>   (prod)
//   /opt/blobrogue-gs/staging  -> releases/<id>   (deploy-preview)
//
// Secrets are NOT inlined here — real values live in the box .env files (chmod 600). Reference
// process.env / the env_file only.

const RELEASES_ROOT = "/opt/blobrogue-gs";

module.exports = {
  apps: [
    {
      name: "blobrogue-gs",
      script: "dist/server/src/main.js",
      cwd: `${RELEASES_ROOT}/current/server`,
      instances: 1,
      exec_mode: "fork", // stateful in-memory worlds — NEVER cluster
      max_memory_restart: "512M",
      autorestart: true,
      env: { NODE_ENV: "production", PORT: "8090", GS_HOST: "127.0.0.1", GS_WS_PATH: "/ws" },
      // GS_AUTH_SECRET + CONVEX_URL come from /opt/blobrogue-gs/.env (never committed).
      error_file: "/var/log/blobrogue-gs/err.log",
      out_file: "/var/log/blobrogue-gs/out.log",
      time: true,
    },
    {
      name: "blobrogue-gs-staging",
      script: "dist/server/src/main.js",
      cwd: `${RELEASES_ROOT}/staging/server`,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "256M",
      autorestart: true,
      env: { NODE_ENV: "production", PORT: "8092", GS_HOST: "127.0.0.1", GS_WS_PATH: "/ws" },
      error_file: "/var/log/blobrogue-gs/staging-err.log",
      out_file: "/var/log/blobrogue-gs/staging-out.log",
      time: true,
    },
    {
      name: "blobrogue-control",
      script: "dist/src/main.js",
      cwd: `${RELEASES_ROOT}/current/control`,
      instances: 1,
      exec_mode: "fork", // one deploy lock lives in this process
      max_memory_restart: "256M",
      autorestart: true,
      env: { NODE_ENV: "production", BRC_HOST: "127.0.0.1", BRC_PORT: "8091" },
      // BRC_* secrets come from /opt/blobrogue-control/.env (never committed).
      error_file: "/var/log/blobrogue-control/err.log",
      out_file: "/var/log/blobrogue-control/out.log",
      time: true,
    },
  ],
};
