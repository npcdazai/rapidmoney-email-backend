module.exports = {
  apps: [
    {
      name: "rapidmoney-email-backend",
      script: "./src/index.js",
      cwd: "/home/ubuntu/rapidMoney_Crm/rapidmoney-email-backend",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "rapidmoney-mail-worker",
      script: "./src/worker.js",
      cwd: "/home/ubuntu/rapidMoney_Crm/rapidmoney-email-backend",
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
