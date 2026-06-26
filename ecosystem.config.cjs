module.exports = {
  apps: [
    {
      name: "rapidmoney-email-backend",
      script: "./src/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};