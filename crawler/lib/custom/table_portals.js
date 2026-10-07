// 表格公司共享入口：一个模块承载多家自建招聘站的官方公开接口（匿名Node、串行>=200ms、15s超时）。
// 每个来源在 FETCHERS 中独立登记，输出已规范的岗位对象；同系统不继承资格，缺入口/失败整源报错不写候选。
// SPEC §4.3：允许单轮采集；官方total与实际唯一数的差异记在 envelope.officialTotal，不伪装成全公司全集。
'use strict';
const fs = require('node:fs');

const ADAPTER = 'table-portal-v1';
const DELAY_MS = 200, TIMEOUT_MS = 15000, MAX_PAGES = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeHttp({ fetchImpl = globalThis.fetch, delayMs = DELAY_MS, sleepImpl = sleep } = {}) {
  let last = 0;
  return async function http(url, { method = 'GET', json, form, headers = {} } = {}) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleepImpl(wait);
    last = Date.now();
    const init = { method, headers: { Accept: 'application/json, text/plain, */*', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (json !== undefined) { init.body = JSON.stringify(json); init.headers['Content-Type'] = 'application/json'; }
    if (form !== undefined) { init.body = new URLSearchParams(form).toString(); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const response = await fetchImpl(url, init);
    if (response.status !== 200) throw new Error('HTTP ' + response.status + ' ' + url);
    const text = await response.text();
    try { return JSON.parse(text); } catch { throw new Error('Non-JSON response ' + url); }
  };
}

const str = value => value == null ? '' : String(value);
const clean = value => str(value).replace(/\r\n?/g, '\n').trim();
// 官方HTML正文转纯文本：去标签、换行标签保留段落、解码常见实体。
function htmlText(value) {
  return clean(str(value)
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'));
}

function job(fields) {
  const duty = clean(fields.duty), requirements = clean(fields.requirements), description = clean(fields.description);
  return {
    id: str(fields.id).trim(), title: clean(fields.title), city: clean(fields.city), category: clean(fields.category),
    channels: fields.channels || [], employment: fields.employment ?? null, talentPlan: fields.talentPlan ?? null,
    date: fields.date ?? null, dateKind: fields.dateKind ?? null, url: fields.url || '',
    duty, requirements, description, jdComplete: /[\p{L}\p{N}]/u.test(duty + requirements + description), sourceStatus: null
  };
}

const FETCHERS = {
  // 美的校招官网：项目通道列表 -> 每通道分页（官网pageSize上限20）；列表自带职责/要求，无需详情。
  async midea(site, http) {
    const base = 'https://careers.midea.com/backend/school/position/common';
    const headers = { Referer: 'https://careers.midea.com/schoolOut/' };
    const projects = await http(base + '/project/list?status=1&projectTypes=1,2,9,5&employementCategories=1,4', { headers });
    if (projects?.code !== '0' || !Array.isArray(projects.data)) throw new Error('Midea project list shape changed');
    const jobs = [];
    let officialTotal = 0;
    for (const project of projects.data) {
      let total;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = { keyword: null, superiorIds: [], recruitCategoryIds: [], workPlaceCodes: [], projectRuleId: project.projectRuleId, pageIndex: page, pageSize: 20 };
        const response = await http(base + '/position/list', { method: 'POST', json: body, headers });
        const data = response?.data;
        if (response?.code !== '0' || !Array.isArray(data?.data) || !Number.isSafeInteger(data.total)) throw new Error('Midea position list shape changed');
        total = data.total;
        for (const item of data.data) {
          const detail = item.projectPositionDto || {};
          const intern = project.employementCategory === 4;
          jobs.push(job({
            id: item.positionId, title: item.projectPositionName,
            city: (item.workplaceDtoList || []).map(w => w.workPlaceName).filter(Boolean).join('/') || item.workPlaceCode,
            category: item.recruitCategoryName, channels: intern ? [] : ['campus'], employment: intern ? 'internship' : null,
            talentPlan: null, url: 'https://careers.midea.com/schoolOut/post',
            duty: detail.jobResponsibility, requirements: detail.jobRequirement
          }));
        }
        if (page >= data.info?.totalPage || !data.data.length) break;
      }
      officialTotal += total || 0;
    }
    return { jobs, officialTotal };
  },
  // 美的社招官网：position/list 表单分页（官网可调pageSize），列表自带职责/要求，无需详情。
  async midea_social(site, http) {
    const url = 'https://recruit.midea.com/backend/rec/home/out/official/position/list';
    const headers = { Referer: 'https://recruit.midea.com/recruitOut/ihr/home/index' };
    const jobs = [];
    let officialTotal;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await http(url, { method: 'POST', form: { pageSize: 100, pageIndex: page, publicationName: '' }, headers });
      if (!Array.isArray(data?.data) || !Number.isSafeInteger(data.total)) throw new Error('Midea social list shape changed');
      officialTotal = data.total;
      for (const item of data.data) {
        jobs.push(job({
          id: item.positionId, title: item.publicationName || item.demandPositionName, city: item.workingPlace,
          category: '', channels: ['social'], url: 'https://recruit.midea.com/recruitOut/ihr/home/index',
          duty: item.postDuties, requirements: item.qualification
        }));
      }
      if (page >= data.info?.totalPage || !data.data.length) break;
    }
    return { jobs, officialTotal };
  }
};

function registered(site) {
  return !!site && site.adapter === ADAPTER && site.ats === 'custom' && Object.hasOwn(FETCHERS, site.fetcher);
}

async function fetchAll(site, options = {}) {
  if (!registered(site)) throw new Error('Unregistered table portal: ' + site?.key);
  const http = options.http || makeHttp(options);
  const { jobs: all, officialTotal } = await FETCHERS[site.fetcher](site, http);
  const seen = new Set(), jobs = [];
  for (const item of all) {
    if (!item.id) throw new Error('Official job without id');
    if (!item.title) throw new Error('Official job without title: ' + item.id);
    if (seen.has(item.id)) continue; // 同来源同官方ID只保留首个
    seen.add(item.id);
    jobs.push(item);
  }
  return { complete: true, total: jobs.length, officialTotal: officialTotal ?? null, duplicatesDropped: all.length - jobs.length, jobs };
}

module.exports = { ADAPTER, FETCHERS, registered, fetchAll, makeHttp, htmlText, job };
if (require.main === module) {
  const [siteJSON, outfile] = process.argv.slice(2);
  Promise.resolve().then(() => fetchAll(JSON.parse(siteJSON))).then(envelope => {
    fs.writeFileSync(outfile, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
    console.log('DONE fetched=' + envelope.total + (envelope.officialTotal != null ? ' official=' + envelope.officialTotal : ''));
  }).catch(error => { console.error('ERR ' + error.message); process.exitCode = 1; });
}
