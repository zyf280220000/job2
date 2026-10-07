'use strict';
// 大数据集分片：超过阈值写入 jobs.partN.js，读取时按序合并；小数据保持单文件并清理旧片段。
const test = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const api = require('../crawler/publish');

test('writeData 超阈值分片，readPublished 合并回原岗位顺序，浏览器加载等价', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-')), file = path.join(dir, 'jobs.js');
  const job = i => ({ id: 's:' + i, sourceKey: 's', company: 'C', title: 'T' + i, city: '', category: '', channels: [], employment: null, talentPlan: null, date: null, dateKind: null, url: '', duty: 'x'.repeat(2000), requirements: '', description: '', jdComplete: true, sourceStatus: null });
  const data = { version: 1, legacy: false, notices: [], companies: [{ name: 'C', initial: 'C', aliases: [] }], sources: [{ key: 's', company: 'C', status: 'ready', lastSuccess: '2026-10-07T00:00:00.000Z', lastAttempt: '2026-10-07T00:00:00.000Z', message: 'm', coverage: 'c' }], jobs: Array.from({ length: 60 }, (_, i) => job(i)) };
  api.writeData(file, data, { threshold: 50000, partTarget: 40000 });
  a.ok(fs.existsSync(path.join(dir, 'jobs.part1.js')) && fs.existsSync(path.join(dir, 'jobs.part4.js')));
  const back = api.readPublished(file);
  a.deepEqual(back.jobs.map(j => j.id), data.jobs.map(j => j.id));
  const ctx = { globalThis: {} }; vm.createContext(ctx);
  for (const f of ['jobs.js', 'jobs.part1.js', 'jobs.part2.js', 'jobs.part3.js', 'jobs.part4.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx);
  a.equal(ctx.globalThis.ANDE_DATA.jobs.length, 0); a.equal(ctx.globalThis.ANDE_PARTS.flat().length, 60);
  api.writeData(file, { ...data, jobs: data.jobs.slice(0, 2) });
  a.equal(fs.existsSync(path.join(dir, 'jobs.part1.js')), false);
  a.equal(api.readPublished(file).jobs.length, 2);
});
