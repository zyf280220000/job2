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
  return async function http(url, { method = 'GET', json, form, headers = {}, preprocess } = {}) {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleepImpl(wait);
    last = Date.now();
    const init = { method, headers: { Accept: 'application/json, text/plain, */*', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (json !== undefined) { init.body = JSON.stringify(json); init.headers['Content-Type'] = 'application/json'; }
    if (form !== undefined) { init.body = new URLSearchParams(form).toString(); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const response = await fetchImpl(url, init);
    if (response.status !== 200) throw new Error('HTTP ' + response.status + ' ' + url);
    const text = await response.text();
    try { return JSON.parse(preprocess ? preprocess(text) : text); } catch { throw new Error('Non-JSON response ' + url); }
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
  },
  // 亚马逊官方招聘站（amazon.jobs）公开search.json，按官网国家筛选China（normalized_country_code=CHN），列表自带完整正文。
  async amazon_cn(site, http) {
    const jobs = [];
    let officialTotal;
    for (let offset = 0; offset < 20000; offset += 100) {
      const data = await http('https://www.amazon.jobs/en/search.json?result_limit=100&sort=recent&normalized_country_code%5B%5D=CHN&offset=' + offset);
      if (!Array.isArray(data?.jobs) || !Number.isSafeInteger(data.hits)) throw new Error('Amazon search shape changed');
      officialTotal = data.hits;
      for (const item of data.jobs) {
        jobs.push(job({
          id: item.id_icims || item.id, title: item.title,
          city: [item.normalized_location || [item.city, item.state, item.country_code].filter(Boolean).join(', ')].join(''),
          category: item.job_category, channels: [], employment: item.is_intern === true || item.is_intern === 'true' ? 'internship' : null,
          url: 'https://www.amazon.jobs' + item.job_path,
          duty: htmlText(item.description), requirements: htmlText([item.basic_qualifications, item.preferred_qualifications].filter(Boolean).join('<br/><br/>'))
        }));
      }
      if (offset + data.jobs.length >= data.hits || !data.jobs.length) break;
    }
    return { jobs, officialTotal };
  },
  // Workday 公开 cxs 接口：按官网国家 facet 筛选，列表分页后逐岗取官方详情（职位描述HTML）。
  async workday(site, http) {
    const { host, tenant, careerSite, country } = site.workday || {};
    if (!host || !tenant || !careerSite || !country) throw new Error('Workday config incomplete');
    const api = `https://${host}/wday/cxs/${tenant}/${careerSite}`;
    const search = (offset, applied, limit = 20) => http(api + '/jobs', { method: 'POST', json: { appliedFacets: applied, limit, offset, searchText: '' } });
    const probe = await search(0, {}, 1);
    const facet = (probe.facets || []).find(f => /country/i.test(f.facetParameter + ' ' + f.descriptor));
    const china = (facet?.values || []).find(v => new RegExp('^' + country, 'i').test(v.descriptor));
    if (!facet || !china) throw new Error('Workday country facet not found: ' + country);
    const applied = { [facet.facetParameter]: [china.id] };
    const postings = [];
    let officialTotal;
    for (let offset = 0; offset < 20000; offset += 20) {
      const data = await search(offset, applied);
      if (!Array.isArray(data?.jobPostings) || !Number.isSafeInteger(data.total)) throw new Error('Workday list shape changed');
      if (offset === 0) officialTotal = data.total;
      postings.push(...data.jobPostings);
      if (!data.jobPostings.length || postings.length >= officialTotal) break;
    }
    const jobs = [];
    for (const posting of postings) {
      if (!posting.externalPath) continue;
      const detail = (await http(api + posting.externalPath))?.jobPostingInfo;
      if (!detail || typeof detail.jobDescription !== 'string') throw new Error('Workday detail shape changed: ' + posting.externalPath);
      jobs.push(job({
        id: detail.jobReqId || posting.bulletFields?.[0] || posting.externalPath, title: detail.title || posting.title,
        city: detail.location || posting.locationsText, category: '', channels: [], employment: /intern/i.test(detail.timeType || '') ? 'internship' : /full/i.test(detail.timeType || '') ? 'full-time' : null,
        url: detail.externalUrl || `https://${host}/en-US/${careerSite}${posting.externalPath}`, description: htmlText(detail.jobDescription)
      }));
    }
    return { jobs, officialTotal };
  },
  // 中智Wecruit（*.hotjob.cn）官方公开接口：listPosition分页（官网固定每页12）+ listPositionDetail取职责/要求。
  async wecruit(site, http) {
    const { origin, suite, types } = site.wecruit || {};
    if (!origin || !suite || !types || typeof types !== 'object') throw new Error('Wecruit config incomplete');
    const q = '?iSaJAx=isAjax&request_locale=zh_CN';
    const headers = { Referer: `${origin}/${suite}/pb/index.html` };
    const jobs = [];
    let officialTotal = 0;
    for (const [recruitType, channel] of Object.entries(types)) {
      const items = [];
      let dataCount;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await http(`${origin}/wecruit/positionInfo/listPosition/${suite}${q}`, { method: 'POST', form: { isFrompb: 'true', recruitType, pageSize: 12, currentPage: page }, headers });
        const form = data?.data?.pageForm;
        if (!form || !Array.isArray(form.pageData) || !Number.isSafeInteger(form.totalPage)) throw new Error('Wecruit list shape changed');
        dataCount = form.dataCount;
        items.push(...form.pageData);
        if (page >= form.totalPage || !form.pageData.length) break;
      }
      officialTotal += Number.isSafeInteger(dataCount) ? dataCount : items.length;
      for (const item of items) {
        const detail = (await http(`${origin}/wecruit/positionInfo/listPositionDetail/${suite}${q}`, { method: 'POST', form: { postId: item.postId, recruitType: '' }, headers }))?.data;
        if (!detail || typeof detail !== 'object') throw new Error('Wecruit detail shape changed: ' + item.postId);
        jobs.push(job({
          id: item.postId, title: item.postName, city: item.workPlaceStr || (detail.workPlaceList || []).map(w => w.name).join('、'),
          category: item.postTypeName, channels: [channel], url: `${origin}/${suite}/pb/posDetail.html?postId=${encodeURIComponent(item.postId)}&postType=${recruitType}`,
          duty: detail.workContent, requirements: detail.serviceCondition
        }));
      }
    }
    return { jobs, officialTotal };
  },
  // SuccessFactors Jobs2Web 招聘站：/services/jobs/search/ 公开JSON列表（按官网地点搜索+国家代码核对）+ 官方职位页正文。
  async sf_rmk(site, http, { text } = {}) {
    const { origin, locationsearch, country } = site.sf || {};
    if (!origin || !locationsearch || !country) throw new Error('SF config incomplete');
    const fetchText = text || (async url => { const r = await fetch(url, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) }); if (r.status !== 200) throw new Error('HTTP ' + r.status + ' ' + url); return r.text(); });
    const rows = [];
    for (let startrow = 0; startrow < 5000; startrow += 50) {
      const data = await http(origin + '/services/jobs/search/', { method: 'POST', headers: { Referer: origin + '/' }, json: { page: 0, keywords: '', locationsearch, sortby: 'referencedate', sortdir: 'desc', sortfield: 'title', recordsperpage: 50, startrow, facetquery: { facet: false } } });
      if (!Array.isArray(data?.jobList)) throw new Error('SF list shape changed');
      rows.push(...data.jobList);
      if (data.jobList.length < 50) break;
    }
    const mine = rows.filter(r => String(r.country).toUpperCase() === country);
    const jobs = [];
    for (const row of mine) {
      const url = `${origin}/job/${row.urltitle}/${row.id}/`;
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      const html = await fetchText(url);
      const start = html.indexOf('<span class="jobdescription">');
      if (start < 0) throw new Error('SF job page shape changed: ' + row.id);
      let depth = 0, end = -1;
      for (const m of html.slice(start).matchAll(/<(\/?)span\b[^>]*>/g)) { depth += m[1] ? -1 : 1; if (depth === 0) { end = start + m.index + m[0].length; break; } }
      if (end < 0) throw new Error('SF job description unterminated: ' + row.id);
      jobs.push(job({
        id: row.id, title: row.title, city: [row.city, row.state].filter(Boolean).join(', ') || row.location, category: row.department,
        channels: [], employment: null, url, description: htmlText(html.slice(start, end))
      }));
    }
    return { jobs, officialTotal: mine.length };
  },
  // 拼多多校招官网：recruit/position/list 分页（官网固定每页10），列表自带岗位职责。
  async pdd_campus(site, http) {
    const url = 'https://careers.pddglobalhr.com/api/careers/api/recruit/position/list';
    const headers = { Referer: 'https://careers.pddglobalhr.com/campus/grad' };
    const jobs = [];
    let officialTotal;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await http(url, { method: 'POST', json: { page, pageSize: 10, t: null }, headers });
      const result = response?.result;
      if (response?.success !== true || !Array.isArray(result?.list) || !Number.isFinite(Number(result.total))) throw new Error('PDD list shape changed');
      officialTotal = Number(result.total);
      for (const item of result.list) {
        jobs.push(job({ id: item.id, title: item.name, city: item.workLocationName || item.workLocation, category: item.jobName, channels: ['campus'], url: 'https://careers.pddglobalhr.com/campus/grad', duty: item.jobDuty, requirements: item.jobRequire || item.jobRequirement }));
      }
      if (!result.list.length || page * 10 >= officialTotal) break;
    }
    return { jobs, officialTotal };
  },
  // 招商银行校招官网：job/getList 分页；列表仅有岗位名、分行、地点、截止日，官网详情接口未适配，正文留空。
  async cmb_campus(site, http) {
    const typeId = site.cmb?.recruitmentTypeId;
    if (!typeId) throw new Error('CMB config incomplete');
    const url = 'https://career.cmbchina.com/api/campusRecruitmentWebsite/job/getList';
    const headers = { Referer: 'https://career.cmbchina.com/' };
    const jobs = [];
    let officialTotal;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await http(url, { method: 'POST', json: { orgIdList: [], keywords: '', locationIdList: [], pageIndex: page, pageSize: 50, recruitmentTypeId: typeId, jobTypeIdList: [] }, headers });
      const body = response?.body;
      if (response?.returnCode !== 'SUC0000' || !Array.isArray(body?.data) || !Number.isSafeInteger(body.total)) throw new Error('CMB list shape changed');
      officialTotal = body.total;
      for (const item of body.data) {
        jobs.push(job({ id: item.publishGID, title: item.jobDisplay, city: item.locationName, category: item.branchCodeName, channels: ['campus'], url: 'https://career.cmbchina.com/positionlist/' + typeId }));
      }
      if (!body.data.length || jobs.length >= officialTotal) break;
    }
    return { jobs, officialTotal };
  },
  // 安克创新官网（飞书开放接口代理）：getJobPosts 分页，列表自带完整岗位描述。
  async anker(site, http) {
    const base = 'https://open.anker-in.com/service/lark/openapi/getJobPosts/6962795203808168199';
    const headers = { Referer: 'https://career.anker.com.cn/' };
    const jobs = [];
    let officialTotal;
    const text = value => { try { const o = JSON.parse(value); return o.zh_cn || o.en_us || ''; } catch { return str(value); } };
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await http(`${base}?page=${page}&size=50`, { method: 'POST', json: {}, headers });
      if (response?.code !== 200 || !Array.isArray(response.data) || !Number.isSafeInteger(response.total)) throw new Error('Anker list shape changed');
      officialTotal = response.total;
      for (const item of response.data) {
        const address = (() => { try { return JSON.parse(item.address).map(a => a.zh_cn || a.en_us).filter(Boolean).join('/'); } catch { return str(item.address); } })();
        const type = text(item.jobRecruitmentType);
        jobs.push(job({ id: item.id, title: item.title, city: address, category: text(item.jobFunction), channels: [], employment: type === '实习' ? 'internship' : type === '全职' ? 'full-time' : null, url: 'https://career.anker.com.cn/', duty: item.description }));
      }
      if (!response.data.length || page * 50 >= officialTotal) break;
    }
    return { jobs, officialTotal };
  },
  // 中信银行官网移动入口：position/all 分页（channelCate=02校招），列表仅岗位名/地点/分行/批次，无JD。
  async citic_campus(site, http) {
    const headers = { Referer: 'https://jobwx.citicbank.com/' };
    const jobs = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await http(`https://jobwx.citicbank.com/recruitmobile/api/position/all?pageNum=${page}&pageSize=50&channelCate=02`, { headers });
      if (response?.success !== true || !Array.isArray(response.data)) throw new Error('CITIC list shape changed');
      for (const item of response.data) {
        jobs.push(job({ id: item.id, title: item.postname, city: item.workaddr, category: item.content, channels: ['campus'], employment: item.GZ === '全职' ? 'full-time' : null, url: 'https://jobwx.citicbank.com/', description: [item.station, item.XLMC && '学历：' + item.XLMC].filter(Boolean).join('\n') }));
      }
      if (response.data.length < 50) break;
    }
    return { jobs, officialTotal: jobs.length };
  },
  // 比亚迪官网（job.byd.com，匿名可读）：position/queryList 按 zpType 分页（社招00251/校园00252/技工00254），
  // 逐岗 position/queryDetail 取「工作职责」「任职要求」。
  async byd(site, http) {
    const { zpType, channel, page: pagePath } = site.byd || {};
    if (!zpType) throw new Error('BYD config incomplete');
    const base = 'https://job.byd.com/portal/api/portal-api';
    const headers = { Referer: 'https://job.byd.com/portal/pc/' };
    const retry = async fn => { let last; for (let i = 0; i < 4; i++) { try { return await fn(); } catch (e) { last = e; await sleep(1500 * (i + 1)); } } throw last; };
    // 官网岗位ID是19位整数，超过JS安全整数范围，必须按字符串读取，否则丢精度并被误判重复。
    const preprocess = text => text.replace(/"(id|relatedId|relatedDetailId)":(\d{12,})/g, '"$1":"$2"');
    const rows = [];
    let officialTotal;
    for (let page = 0; page < 5000; page++) {
      const body = { positionTypeArr: [], positionProvinceArr: [], positionCityArr: [], positionOrgArr: [], vagueCondition: '', searchType: 1, zpType, pageNum: page, pageSize: 100 };
      const response = await retry(() => http(base + '/position/queryList', { method: 'POST', json: body, headers, preprocess }));
      const data = response?.data;
      if (response?.code !== 0 || !Array.isArray(data?.data) || !Number.isSafeInteger(data.total)) throw new Error('BYD list shape changed');
      officialTotal = data.total;
      rows.push(...data.data);
      if (!data.data.length || rows.length >= officialTotal) break;
    }
    const jobs = [];
    let detailFailures = 0;
    for (const row of rows) {
      // SPEC §4.3：个别详情失败不拖垮整源，保留标题/城市/官网链接，正文留空并计数。
      let detail = null;
      try { detail = (await retry(() => http(base + '/position/queryDetail', { method: 'POST', json: { id: row.id }, headers, preprocess })))?.data; } catch { detail = null; }
      if (!detail || !Array.isArray(detail.tagDetailList)) { detail = { tagDetailList: [] }; detailFailures++; }
      const part = name => detail.tagDetailList.filter(t => t.name === name).map(t => clean(t.detail)).join('\n');
      jobs.push(job({
        id: row.id, title: row.positionName, city: [row.province, row.city].filter(Boolean).join('-'), category: '',
        channels: channel ? [channel] : [], url: 'https://job.byd.com/portal/pc/#/' + (pagePath || 'social/socialMainPageSocial'),
        duty: part('工作职责'), requirements: part('任职要求'),
        description: [row.fatherOrgAliasName, row.orgAliasName].filter(Boolean).length ? '所属部门：' + [row.fatherOrgAliasName, row.orgAliasName].filter(Boolean).join(' / ') : ''
      }));
    }
    if (detailFailures > rows.length * 0.2) throw new Error('BYD detail failed for too many jobs: ' + detailFailures + '/' + rows.length);
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
