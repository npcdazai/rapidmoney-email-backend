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
      // Allow a larger V8 heap so a big customer-master workbook can be parsed
      // in memory (backed by swap). Restart via: pm2 restart <name> --update-env
      node_args: "--max-old-space-size=3072",
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
