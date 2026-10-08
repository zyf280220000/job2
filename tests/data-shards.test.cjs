'use strict';
// 大数据集分包：超过阈值写入 <name>-packs/，readPublished 按清单合并；小数据保持单文件并清理旧包/旧分片。
const test = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const api = require('../crawler/publish');
const job = (i, key) => ({ id: key + ':' + i, sourceKey: key, company: key === 'a' ? 'A公司' : 'B公司', title: 'T' + i, city: '', category: '', channels: [], employment: null, talentPlan: null, date: null, dateKind: null, url: '', duty: 'x'.repeat(2000), requirements: '', description: '', jdComplete: true, sourceStatus: null });
const src = (key, company) => ({ key, company, status: 'ready', lastSuccess: '2026-10-07T00:00:00.000Z', lastAttempt: '2026-10-07T00:00:00.000Z', message: 'm', coverage: 'c' });
const dataset = () => ({ version: 1, legacy: false, notices: [], companies: [{ name: 'A公司', initial: 'A', aliases: [] }, { name: 'B公司', initial: 'B', aliases: [] }], sources: [src('a', 'A公司'), src('b', 'B公司')], jobs: [...Array.from({ length: 30 }, (_, i) => job(i, 'a')), ...Array.from({ length: 10 }, (_, i) => job(i, 'b'))] });

test('writeData 超阈值按来源分包，readPublished 合并回同一批岗位，浏览器脚本可逐包加载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-')), file = path.join(dir, 'jobs.js'), data = dataset();
  api.writeData(file, data, { threshold: 50000, packTarget: 20000 });
  const ctx = { globalThis: {} }; vm.createContext(ctx); vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  const main = ctx.globalThis.ANDE_DATA;
  a.equal(main.jobs.length, 0); a.equal(main.packBase, 'jobs-packs/'); a.deepEqual(JSON.parse(JSON.stringify(main.sourceCounts)), { a: 30, b: 10 });
  a.ok(main.packs.length > 3); a.equal(main.packs.reduce((n, p) => n + p.count, 0), 40);
  a.ok(main.packs.every(p => /^p\d{4}-[0-9a-f]{10}\.js$/.test(p.file) && p.bytes < 40000));
  for (const p of main.packs) vm.runInContext(fs.readFileSync(path.join(dir, 'jobs-packs', p.file), 'utf8'), ctx);
  a.equal(Object.values(ctx.globalThis.ANDE_PACKS).flat().length, 40);
  const back = api.readPublished(file);
  a.deepEqual(back.jobs.map(j => j.id).sort(), data.jobs.map(j => j.id).sort());
  a.equal(back.packs, undefined);
  // 同来源只在含该来源的包里：按单位加载不会下载无关来源
  a.ok(main.packs.some(p => p.sources.length === 1 && p.sources[0] === 'b'));
});

test('相同数据重复发布得到相同包名；数据变小后回单文件并清理旧包与旧分片', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-')), file = path.join(dir, 'jobs.js'), data = dataset();
  api.writeData(file, data, { threshold: 50000, packTarget: 20000 });
  const first = fs.readdirSync(path.join(dir, 'jobs-packs')).sort();
  api.writeData(file, data, { threshold: 50000, packTarget: 20000 });
  a.deepEqual(fs.readdirSync(path.join(dir, 'jobs-packs')).sort(), first);
  fs.writeFileSync(path.join(dir, 'jobs.part1.js'), 'stale');
  api.writeData(file, { ...data, jobs: data.jobs.slice(0, 2) });
  a.deepEqual(fs.readdirSync(path.join(dir, 'jobs-packs')), []);
  a.equal(fs.existsSync(path.join(dir, 'jobs.part1.js')), false);
  a.equal(api.readPublished(file).jobs.length, 2);
});
