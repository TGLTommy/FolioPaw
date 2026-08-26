#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', 'data', 'uploads']);
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
walk(root);

if (findings.length > 0) {
  console.error('Secret and private-data scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Secret and private-data scan passed.');

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, fullPath);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(entry.name)) continue;
    const lowerName = entry.name.toLowerCase();
    const isLocalEnv = lowerName.startsWith('.env.') && lowerName !== '.env.example';
    const isDatabaseSidecar = /\.(?:db|sqlite|sqlite3)(?:[-.].+)?$/i.test(entry.name);
    if (
      forbiddenFileNames.has(lowerName) ||
      isLocalEnv ||
      isDatabaseSidecar ||
      forbiddenExtensions.has(path.extname(entry.name).toLowerCase())
    ) {
      findings.push(`${relativePath}: forbidden private/binary file type`);
      continue;
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > 2 * 1024 * 1024) continue;
    const buffer = fs.readFileSync(fullPath);
    if (buffer.includes(0)) continue;
    const content = buffer.toString('utf8');

    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(content);
      if (!match) continue;
      const line = content.slice(0, match.index).split('\n').length;
      findings.push(`${relativePath}:${line}: ${label}`);
    }
  }
}
