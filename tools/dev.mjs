import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', 'services/api/src/server.mjs'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '--workspace', 'apps/studio', '--', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
