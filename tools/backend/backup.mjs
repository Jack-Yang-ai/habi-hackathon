/** Consistent local SQLite snapshot plus its referenced photos. No audio or network. */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod, copyFile, lstat, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.umask(0o077);
const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, output: { type: 'string' } } });
const source = path.resolve(values['data-dir'] || process.env.DATA_DIR || path.join(root, '.data'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
const destination = path.resolve(values.output || path.join(root, '.tools/backend-backups', stamp));
const dbFile = path.join(source, 'companion.sqlite');
if (!(await lstat(dbFile)).isFile()) throw new Error('Existing backend database required');
await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
await mkdir(destination, { mode: 0o700 }); // Never replace an existing backup.
const target = path.join(destination, 'companion.sqlite');
const original = new DatabaseSync(dbFile, { readOnly: true });
try { original.exec("PRAGMA busy_timeout=5000; VACUUM INTO '" + target.replaceAll("'", "''") + "'"); }
finally { original.close(); }
await chmod(target, 0o600);
const snapshot = new DatabaseSync(target, { readOnly: true });
let rows, captures;
try {
  if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed');
  rows = snapshot.prepare('SELECT count(*) AS count FROM documents').get().count;
  captures = snapshot.prepare("SELECT payload FROM documents WHERE kind='captures'").all().map(row => JSON.parse(row.payload));
} finally { snapshot.close(); }
await mkdir(path.join(destination, 'media'), { mode: 0o700 });
const media = [];
for (const capture of captures) {
  const filename = capture.filename;
  if (!filename || path.basename(filename) !== filename) throw new Error('Invalid photo filename in snapshot');
  const input = path.join(source, 'media', filename);
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Snapshot photo must be a regular file');
  const output = path.join(destination, 'media', filename);
  await copyFile(input, output); await chmod(output, 0o600);
  const hash = createHash('sha256').update(await readFile(output)).digest('hex');
  if (hash !== capture.sha256) throw new Error('Snapshot photo hash mismatch');
  media.push({ filename, sha256: hash, bytes: info.size });
}
const manifest = { createdAt: new Date().toISOString(), integrity: 'ok', documents: rows, photos: media,
  databaseSha256: createHash('sha256').update(await readFile(target)).digest('hex'),
  audioIncluded: false, credentialsIncluded: false };
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ backup: destination, integrity: 'ok', documents: rows,
  photos: media.length, audioIncluded: false, credentialsIncluded: false }) + '\n');
