#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const repository = process.env.STAR_HISTORY_REPOSITORY || process.env.GITHUB_REPOSITORY;

if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('请通过 STAR_HISTORY_REPOSITORY 或 GITHUB_REPOSITORY 提供 owner/repo。');
}

const outputDirectory = path.resolve(
  root,
  process.env.STAR_HISTORY_OUTPUT_DIR || 'docs/star-history',
);
const dataPath = path.join(outputDirectory, 'data.json');
const timestamp = resolveTimestamp();
const stars = await resolveStarCount(repository);
const data = readData(dataPath, repository);
const previous = data.history.at(-1);

if (!previous || previous.stars !== stars) {
  data.history.push({ timestamp, stars });
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
fs.writeFileSync(
  path.join(outputDirectory, 'star-history-light.svg'),
  renderChart(data, 'light'),
);
fs.writeFileSync(
  path.join(outputDirectory, 'star-history-dark.svg'),
  renderChart(data, 'dark'),
);

console.log(
  previous?.stars === stars
    ? `Star 数仍为 ${stars}，图表无需新增数据点。`
    : `已记录 ${repository} 的 Star 数：${stars}。`,
);

function resolveTimestamp() {
  const date = process.env.STAR_HISTORY_NOW
    ? new Date(process.env.STAR_HISTORY_NOW)
    : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error('STAR_HISTORY_NOW 不是有效日期。');
  }
  return date.toISOString();
}

async function resolveStarCount(repo) {
  if (process.env.STAR_HISTORY_COUNT !== undefined) {
    return parseStarCount(process.env.STAR_HISTORY_COUNT);
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FolioPaw-Star-History',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API 返回 ${response.status}，无法获取 Star 数。`);
  }

  const payload = await response.json();
  return parseStarCount(payload.stargazers_count);
}

function parseStarCount(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`无效的 Star 数：${value}`);
  }
  return parsed;
}

function readData(filePath, repo) {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, repository: repo, history: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (parsed.schemaVersion !== 1 || parsed.repository !== repo || !Array.isArray(parsed.history)) {
    throw new Error('现有 Star 历史数据格式或仓库名称不匹配。');
  }

  for (const point of parsed.history) {
    if (
      !point ||
      Number.isNaN(new Date(point.timestamp).getTime()) ||
      !Number.isSafeInteger(point.stars) ||
      point.stars < 0
    ) {
      throw new Error('现有 Star 历史数据包含无效数据点。');
    }
  }

  parsed.history.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return parsed;
}

function renderChart(data, mode) {
  const palette = mode === 'dark'
    ? {
        background: '#0d1117',
        panel: '#161b22',
        border: '#30363d',
        grid: '#30363d',
        text: '#f0f6fc',
        muted: '#8b949e',
        line: '#58a6ff',
        fillStart: '#58a6ff55',
        fillEnd: '#58a6ff05',
      }
    : {
        background: '#ffffff',
        panel: '#f6f8fa',
        border: '#d0d7de',
        grid: '#d8dee4',
        text: '#1f2328',
        muted: '#59636e',
        line: '#0969da',
        fillStart: '#54aeff66',
        fillEnd: '#54aeff08',
      };
  const width = 960;
  const height = 420;
  const plot = { left: 76, top: 104, right: 924, bottom: 342 };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const history = data.history;
  const first = history[0];
  const last = history.at(-1);
  const firstTime = new Date(first.timestamp).getTime();
  const lastTime = new Date(last.timestamp).getTime();
  const timeSpan = lastTime - firstTime;
  const maximumStars = Math.max(...history.map((point) => point.stars));
  const yMaximum = niceMaximum(maximumStars);
  const points = history.map((point) => {
    const pointTime = new Date(point.timestamp).getTime();
    const x = timeSpan === 0
      ? plot.left + plotWidth / 2
      : plot.left + ((pointTime - firstTime) / timeSpan) * plotWidth;
    const y = plot.bottom - (point.stars / yMaximum) * plotHeight;
    return { ...point, x, y };
  });
  const linePath = points.length === 1
    ? `M ${format(points[0].x)} ${format(points[0].y)}`
    : points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${format(point.x)} ${format(point.y)}`).join(' ');
  const areaPath = points.length > 1
    ? `${linePath} L ${format(points.at(-1).x)} ${plot.bottom} L ${format(points[0].x)} ${plot.bottom} Z`
    : '';
  const grid = Array.from({ length: 6 }, (_, index) => {
    const ratio = index / 5;
    const y = plot.bottom - ratio * plotHeight;
    const value = Math.round(ratio * yMaximum);
    return `<line x1="${plot.left}" y1="${format(y)}" x2="${plot.right}" y2="${format(y)}" stroke="${palette.grid}" stroke-width="1" />\n    <text x="${plot.left - 16}" y="${format(y + 5)}" text-anchor="end" fill="${palette.muted}" font-size="13">${value}</text>`;
  }).join('\n    ');
  const startDate = formatDate(first.timestamp);
  const endDate = formatDate(last.timestamp);
  const dateLabels = timeSpan === 0
    ? `<text x="${plot.left + plotWidth / 2}" y="${plot.bottom + 32}" text-anchor="middle" fill="${palette.muted}" font-size="13">${startDate}</text>`
    : `<text x="${plot.left}" y="${plot.bottom + 32}" fill="${palette.muted}" font-size="13">${startDate}</text>\n    <text x="${plot.right}" y="${plot.bottom + 32}" text-anchor="end" fill="${palette.muted}" font-size="13">${endDate}</text>`;
  const circles = points.map((point) => (
    `<circle cx="${format(point.x)}" cy="${format(point.y)}" r="4" fill="${palette.background}" stroke="${palette.line}" stroke-width="3"><title>${escapeXml(formatDateTime(point.timestamp))}: ${point.stars} Stars</title></circle>`
  )).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">FolioPaw GitHub Star 增长趋势</title>
  <desc id="description">${escapeXml(startDate)} 至 ${escapeXml(endDate)}，当前 ${last.stars} Stars。</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${palette.fillStart}" />
      <stop offset="100%" stop-color="${palette.fillEnd}" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="${palette.background}" />
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="17" fill="none" stroke="${palette.border}" stroke-width="2" />
  <text x="36" y="46" fill="${palette.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="700">FolioPaw Star 增长趋势</text>
  <text x="36" y="74" fill="${palette.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14">由 GitHub Actions 自动更新 · 数据从 ${escapeXml(startDate)} 开始记录</text>
  <rect x="${width - 168}" y="24" width="132" height="54" rx="12" fill="${palette.panel}" stroke="${palette.border}" />
  <text x="${width - 102}" y="47" text-anchor="middle" fill="${palette.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12">当前热度</text>
  <text x="${width - 102}" y="68" text-anchor="middle" fill="${palette.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="700">★ ${last.stars}</text>
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
    ${grid}
    ${dateLabels}
    ${areaPath ? `<path d="${areaPath}" fill="url(#area)" />` : ''}
    <path d="${linePath}" fill="none" stroke="${palette.line}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    ${circles}
  </g>
  <text x="${width - 36}" y="${height - 22}" text-anchor="end" fill="${palette.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12">github.com/${escapeXml(data.repository)}</text>
</svg>
`;
}

function niceMaximum(value) {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function format(value) {
  return Number(value.toFixed(2));
}

function formatDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function formatDateTime(value) {
  return new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
