module.exports = {
  apps: [{
    name: 'paperclip',
    script: 'scripts/dev-runner.mjs',
    args: 'watch',
    cwd: 'C:\\Users\\mikeb\\paperclip',
    env: {
      PATH: 'C:\\Users\\mikeb\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;' + process.env.PATH,
    },
  }]
};
