#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
// Only used when git cannot enumerate the repository (see collectScannableFiles).
const ignoredDirectories = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'data', 'uploads',
]);
const ignoredFiles = new Set(['package-lock.json']);
const forbiddenFileNames = new Set(['.env', '.jwt-secret', 'auth.json']);
const forbiddenExtensions = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.epub',
  '.pdf',
  '.pem',
  '.key',
  '.gguf',
  '.safetensors',
]);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['provider token', /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/gm],
  ['GitHub token', /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/gm],
  ['AWS access key', /(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}/gm],
  ['Google API key', /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/gm],
  ['personal macOS path', /\/Users\/[A-Za-z0-9._-]+\//g],
];

const findings = [];
for (const relativePath of collectScannableFiles()) {
  scanFile(relativePath);
}

if (findings.length > 0) {
  console.error('Secret and private-data scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Secret and private-data scan passed.');

/**
 * The scan protects what the repository can publish, so it must consider
 * exactly the files git would carry: everything tracked, plus untracked files
 * that no .gitignore layer excludes. Local build output and runtime data are
 * unpublishable and would otherwise produce failures nobody can act on.
 *
 * Falls back to a filesystem walk when git is unavailable or this is not a
 * repository (for example a source tarball), where scanning too much is the
 * safer failure mode.
 */
function collectScannableFiles() {
  const tracked = listFilesFromGit();
  if (tracked && tracked.length > 0) return tracked.filter(isScannableName);

  console.warn('git could not enumerate the repository; falling back to a filesystem walk.');
  const walked = [];
  walkFilesystem(root, walked);
  return walked.filter(isScannableName);
}

function listFilesFromGit() {
  try {
    const output = execFileSync(
      'git',
      // Tracked files plus untracked-but-not-ignored ones. NUL separated so
      // paths with spaces or non-ASCII characters survive verbatim.
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walkFilesystem(directory, collected) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walkFilesystem(path.join(directory, entry.name), collected);
      continue;
    }
    if (!entry.isFile()) continue;
    collected.push(path.relative(root, path.join(directory, entry.name)));
  }
}

function isScannableName(relativePath) {
  return !ignoredFiles.has(path.basename(relativePath));
}

function scanFile(relativePath) {
  const fullPath = path.join(root, relativePath);
  const name = path.basename(relativePath);
  const lowerName = name.toLowerCase();
  const isLocalEnv = lowerName.startsWith('.env.') && lowerName !== '.env.example';
  const isDatabaseSidecar = /\.(?:db|sqlite|sqlite3)(?:[-.].+)?$/i.test(name);

  if (
    forbiddenFileNames.has(lowerName) ||
    isLocalEnv ||
    isDatabaseSidecar ||
    forbiddenExtensions.has(path.extname(name).toLowerCase())
  ) {
    findings.push(`${relativePath}: forbidden private/binary file type`);
    return;
  }

  let buffer;
  try {
    // git also reports files staged for deletion, which no longer exist.
    if (fs.statSync(fullPath).size > 2 * 1024 * 1024) return;
    buffer = fs.readFileSync(fullPath);
  } catch {
    return;
  }
  if (buffer.includes(0)) return;
  const content = buffer.toString('utf8');

  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split('\n').length;
    findings.push(`${relativePath}:${line}: ${label}`);
  }
}
