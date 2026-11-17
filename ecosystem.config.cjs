// pm2 config: `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: "jarvis",
      script: "index.js",
      // Windows has no catchable stop signal, so pm2 sends a "shutdown" message the bot listens for.
      shutdown_with_message: true,
      kill_timeout: 5000, // ms pm2 waits for the bot to go offline before force-killing it
    },
  ],
};
