#!/usr/bin/env node
// 审查从 GitHub 拉下来的候选技能：大小、是否带脚本、是否有安装 / 外发 / 云平台依赖。只读，不执行任何东西。
// 用法：node review-remote-skills.mjs <审查目录>   （目录里有 list.txt、*.tree.json、md/）
import fs from 'node:fs';
import path from 'node:path';

const D = process.argv[2];
const tree = name => JSON.parse(fs.readFileSync(path.join(D, name + '.tree.json'), 'utf8')).tree;
const trees = {};
const rows = [];
for (const line of fs.readFileSync(path.join(D, 'list.txt'), 'utf8').trim().split(/\r?\n/)) {
  const [repo, p, cat] = line.split('|');
  const key = repo.replace('/', '_');
  trees[key] = trees[key] || tree(key);
  const blobs = trees[key].filter(x => x.type === 'blob' && x.path.startsWith(p + '/'));
  const kb = Math.round(blobs.reduce((a, x) => a + (x.size || 0), 0) / 1024);
  const scripts = blobs.filter(x => /\.(py|sh|js|mjs|ts|ps1|bat)$/.test(x.path)).map(x => x.path.slice(p.length + 1));
  const md = fs.readFileSync(path.join(D, 'md', (repo + '/' + p).replace(/\//g, '_') + '.md'), 'utf8');
  const fm = (md.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const desc = ((fm.match(/description:\s*([\s\S]*?)(?:\n[\w-]+:|$)/) || [])[1] || '').replace(/\s+/g, ' ').replace(/^["'>|-]+\s*/, '').slice(0, 120);
  const flags = [];
  if (/pip install|npm install|npx |brew install|apt(-get)? install|curl[^\n]*\|\s*(sh|bash)/i.test(md)) flags.push('装东西');
  if (/curl\s+-X\s+POST|webhook|send (data|telemetry)|analytics|track(ing)? event/i.test(md)) flags.push('外发?');
  if (/\bAWS\b|Azure|\bGCP\b|Kubernetes|kubectl|terraform/i.test(md)) flags.push('云/K8s');
  if (scripts.length) flags.push(`脚本${scripts.length}`);
  rows.push({ cat, repo, path: p, name: p.split('/').pop(), kb, lines: md.split('\n').length, flags, scripts, desc });
}
for (const r of rows) console.log(r.cat.padEnd(4), (r.repo.slice(0, 4) + ':' + r.name).padEnd(30), String(r.kb + 'KB').padEnd(6), (r.flags.join(',') || 'OK').padEnd(18), '|', r.desc);
fs.writeFileSync(path.join(D, 'review.json'), JSON.stringify(rows, null, 2));
