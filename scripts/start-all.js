const { spawn } = require('child_process');
const path = require('path');

const services = [
  { name: 'API     ', color: '\x1b[36m', cmd: 'node', args: ['dist/api/server.js'] },
  { name: 'RELAY   ', color: '\x1b[33m', cmd: 'node', args: ['dist/relay/main.js'] },
  { name: 'SYNC    ', color: '\x1b[35m', cmd: 'node', args: ['dist/consumer/syncMain.js'] },
  { name: 'DOWNLOAD', color: '\x1b[32m', cmd: 'node', args: ['dist/consumer/downloadMain.js'] },
];

const reset = '\x1b[0m';
const children = [];

console.log('\x1b[1m\x1b[34m========================================\x1b[0m');
console.log('\x1b[1m\x1b[34m  Starting All 4 Saral Services...      \x1b[0m');
console.log('\x1b[1m\x1b[34m========================================\x1b[0m\n');

services.forEach((svc) => {
  const child = spawn(svc.cmd, svc.args, {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SERVICE_NAME: svc.name.trim().toLowerCase() },
  });

  children.push(child);

  const prefix = `${svc.color}[${svc.name}]${reset} `;

  child.stdout.on('data', (data) => {
    const lines = data.toString().trimEnd().split('\n');
    lines.forEach((line) => {
      if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
    });
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().trimEnd().split('\n');
    lines.forEach((line) => {
      if (line.trim()) process.stderr.write(`${prefix}\x1b[31m${line}${reset}\n`);
    });
  });

  child.on('exit', (code, signal) => {
    console.log(`${prefix}Exited with code ${code !== null ? code : signal}`);
  });
});

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log('\n\x1b[1m\x1b[31m[RUNNER] Gracefully shutting down all services...\x1b[0m');
  children.forEach((child) => {
    if (!child.killed) {
      child.kill('SIGINT');
    }
  });
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
