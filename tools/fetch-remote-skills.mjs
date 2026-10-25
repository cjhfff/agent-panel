#!/usr/bin/env node
// 用 gh api 把指定技能目录完整下载到审查目录（只下载，不执行）。
// 用法：node fetch-remote-skills.mjs <审查目录> <清单.txt>   清单每行：仓库|目录路径|分类|本地名
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [D, listFile] = process.argv.slice(2);
const trees = {};
const out = path.join(D, 'full');
for (const line of fs.readFileSync(listFile, 'utf8').trim().split(/\r?\n/)) {
  const [repo, dir, , name] = line.split('|');
  const key = repo.replace('/', '_');
  trees[key] = trees[key] || JSON.parse(fs.readFileSync(path.join(D, key + '.tree.json'), 'utf8')).tree;
  const blobs = trees[key].filter(x => x.type === 'blob' && x.path.startsWith(dir + '/'));
  let n = 0, bytes = 0;
  for (const b of blobs) {
    const rel = b.path.slice(dir.length + 1), dst = path.join(out, name, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst) && fs.statSync(dst).size === b.size) { n++; bytes += b.size; continue; } // 已下载，跳过
    let buf;
    for (let i = 0; i < 5 && !buf; i++) { try { buf = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${encodeURI(b.path)}`], { maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']); } }
    if (!buf) throw new Error('下载失败（重试 5 次）：' + b.path);
    fs.writeFileSync(dst, buf); n++; bytes += buf.length;
  }
  console.log(`${name.padEnd(22)} ${String(n).padStart(3)} 个文件  ${Math.round(bytes / 1024)}KB  ← ${repo}/${dir}`);
}
