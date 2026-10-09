'use strict';
// 表格公司共享入口：全部使用注入的HTTP响应，离线验证，不访问官网。
const test = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const portals = require('../crawler/lib/custom/table_portals');
const crawl = require('../crawler/crawl');
const api = require('../crawler/publish');

const site = (fetcher, extra = {}) => ({ key: 'x_' + fetcher, company: '测试公司', ats: 'custom', adapter: 'table-portal-v1', fetcher, url: 'https://example.com/', batch: '测试', ...extra });
const noWait = { delayMs: 0, sleepImpl: async () => {} };
const fakeFetch = routes => async (url, init) => {
  const key = Object.keys(routes).find(k => url.includes(k));
  if (!key) return { status: 404, text: async () => '{}' };
  const body = typeof routes[key] === 'function' ? routes[key](url, init) : routes[key];
  return { status: 200, text: async () => JSON.stringify(body) };
};

test('registered() 只接受登记的 fetcher，其余自定义站不会被执行', () => {
  a.equal(portals.registered(site('midea')), true);
  a.equal(portals.registered(site('not_a_fetcher')), false);
  a.equal(portals.registered({ ...site('midea'), adapter: 'other' }), false);
  a.equal(crawl.adapterCommand(site('midea'), '/tmp/raw.json').script.endsWith('table_portals.js'), true);
  a.equal(crawl.adapterCommand({ ...site('midea'), adapter: undefined }, '/tmp/raw.json'), null);
});

test('midea 分页取职责/要求，官方total与实际数量一致，并按官方ID去重', async () => {
  const item = (id, name) => ({ positionId: id, projectPositionName: name, workPlaceCode: '佛山市', recruitCategoryName: '研发技术类', workplaceDtoList: [{ workPlaceName: '佛山市' }], projectPositionDto: { jobResponsibility: '1、负责研发', jobRequirement: '1、硕士' } });
  const http = portals.makeHttp({ ...noWait, fetchImpl: fakeFetch({
    '/project/list': { code: '0', data: [{ projectRuleId: 'p1', employementCategory: 1 }, { projectRuleId: 'p2', employementCategory: 4 }] },
    '/position/list': (url, init) => {
      const body = JSON.parse(init.body);
      return body.projectRuleId === 'p1'
        ? { code: '0', data: { total: 3, info: { totalPage: 2 }, data: body.pageIndex === 1 ? [item('a', 'A'), item('b', 'B')] : [item('b', 'B')] } }
        : { code: '0', data: { total: 1, info: { totalPage: 1 }, data: [item('c', 'C')] } };
    }
  }) });
  const result = await portals.fetchAll(site('midea'), { http });
  a.equal(result.total, 3); a.equal(result.officialTotal, 4); a.equal(result.duplicatesDropped, 1);
  const c = result.jobs.find(j => j.id === 'c');
  a.equal(c.employment, 'internship'); a.deepEqual(c.channels, []);
  a.deepEqual(result.jobs.find(j => j.id === 'a').channels, ['campus']);
  a.equal(result.jobs[0].jdComplete, true);
});

test('接口结构变化、HTTP失败或缺标题时整源报错，不写出空结果', async () => {
  const bad = portals.makeHttp({ ...noWait, fetchImpl: fakeFetch({ '/project/list': { code: '500' } }) });
  await a.rejects(() => portals.fetchAll(site('midea'), { http: bad }), /shape changed/);
  const down = portals.makeHttp({ ...noWait, fetchImpl: async () => ({ status: 403, text: async () => '' }) });
  await a.rejects(() => portals.fetchAll(site('midea_social'), { http: down }), /HTTP 403/);
  const noTitle = portals.makeHttp({ ...noWait, fetchImpl: fakeFetch({ '/position/list': { total: 1, info: { totalPage: 1 }, data: [{ positionId: 'z', publicationName: '' }] } }) });
  await a.rejects(() => portals.fetchAll(site('midea_social'), { http: noTitle }), /without title/);
});

test('workday 按国家facet分页并取官方详情', async () => {
  const cfg = { workday: { host: 'h.example.com', tenant: 't', careerSite: 'S', country: 'China' } };
  const http = portals.makeHttp({ ...noWait, fetchImpl: fakeFetch({
    '/jobs': (url, init) => {
      const body = JSON.parse(init.body);
      return { total: 1, facets: [{ facetParameter: 'Country', descriptor: 'Location Country', values: [{ descriptor: 'China', id: 'cn1', count: 1 }] }], jobPostings: body.limit === 1 && !body.appliedFacets.Country ? [] : [{ title: 'Eng', externalPath: '/job/x_R1', locationsText: 'Shanghai, CN', bulletFields: ['R1'] }] };
    },
    '/job/x_R1': { jobPostingInfo: { title: 'Eng', jobReqId: 'R1', location: 'Shanghai, CN', timeType: 'Full time', externalUrl: 'https://h.example.com/en-US/S/job/x_R1', jobDescription: '<p>Do <b>things</b></p><br/>Req&nbsp;1' } }
  }) });
  const result = await portals.fetchAll(site('workday', cfg), { http });
  a.equal(result.total, 1); a.equal(result.jobs[0].id, 'R1'); a.equal(result.jobs[0].employment, 'full-time');
  a.match(result.jobs[0].description, /Do things/);
});

test('完整链路：crawl 晋升快照后 publisher 发布，非目标岗位与时间不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-'));
  const s = site('midea');
  const runner = (_node, args) => {
    fs.writeFileSync(args[2], JSON.stringify({ complete: true, total: 1, officialTotal: 1, jobs: [{ id: 'a', title: '研究员', city: '佛山市', category: '研发技术类', channels: ['campus'], employment: null, talentPlan: null, date: null, dateKind: null, url: 'https://careers.midea.com/schoolOut/post', duty: '负责研发', requirements: '硕士', description: '', jdComplete: true, sourceStatus: null }] }));
    return { status: 0, stdout: 'DONE', stderr: '' };
  };
  const result = crawl.runCrawl(s, { outDir: dir, runner, now: () => '2026-10-07T00:00:00.000Z' });
  a.equal(result.status, 'ready');
  const rows = api.normalizeJobs(JSON.parse(fs.readFileSync(path.join(dir, s.key + '_snapshot.json'), 'utf8')).jobs, s);
  a.equal(rows[0].id, s.key + ':a'); a.equal(rows[0].jdComplete, true); a.deepEqual(rows[0].channels, ['campus']);
});

test('大量重复官方ID说明分页异常，整源拒绝而不是静默去重', async () => {
  const item = id => ({ positionId: id, publicationName: 'T' + id, workingPlace: '深圳', postDuties: '职责', qualification: '要求' });
  const rows = Array.from({ length: 40 }, (_, i) => item('same' + (i % 3)));
  const http = portals.makeHttp({ ...noWait, fetchImpl: fakeFetch({ '/position/list': { total: 40, info: { totalPage: 1 }, data: rows } }) });
  await a.rejects(() => portals.fetchAll(site('midea_social'), { http }), /duplicate official IDs/);
});
