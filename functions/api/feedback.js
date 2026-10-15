/**
 * 建议反馈 API —— 代理 GitHub Issues（方案 A）
 *
 * 部署：Cloudflare Pages Functions（与站点同域，无需新增被墙域名）
 * 环境变量（Pages 项目 Settings → Environment variables）：
 *   GITHUB_TOKEN  必填，Fine-grained PAT（仅本仓库 Issues 读写 + Contents 读写）
 *   GITHUB_OWNER  必填，仓库属主，如 Wang-738B
 *   GITHUB_REPO   必填，仓库名，如 xylx
 *   FEEDBACK_KV   可选，KV Namespace 绑定名（用于按 IP 限流；不配置则跳过限流）
 *
 * 路由：
 *   GET  /api/feedback?cursor=页码&pageSize=条数  → 读取公开 Issues 列表
 *   POST /api/feedback {type,name,content,hp}     → 创建 Issue（蜜罐拦截机器人）
 */

const API_BASE = 'https://api.github.com';
const LABEL_ALL = 'feedback'; // 所有反馈统一挂的标签
const TYPE_LABELS = { suggestion: '建议', bug: '问题', question: '咨询' };
const MAX_NAME = 20;
const MAX_CONTENT = 500;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    return json({ error: '服务端未配置 GitHub 环境变量' }, 500);
  }

  try {
    if (request.method === 'GET') return await handleGet(env, url);
    if (request.method === 'POST') return await handlePost(request, env);
    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: err.message || '服务异常' }, 500);
  }
}

/* ── 读取列表 ─────────────────────────────────────────────── */
async function handleGet(env, url) {
  const page = Math.max(1, parseInt(url.searchParams.get('cursor') || '1', 10) || 1);
  const pageSize = Math.min(20, parseInt(url.searchParams.get('pageSize') || '4', 10) || 4);

  const res = await fetch(
    `${API_BASE}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?state=all&labels=${LABEL_ALL}&per_page=${pageSize}&page=${page}`,
    ghHeaders(env)
  );
  if (!res.ok) throw new Error(`GitHub 读取失败 (${res.status})`);
  const issues = await res.json();

  const messages = issues.map(issueToMessage);
  return json({
    messages,
    nextCursor: messages.length === pageSize ? page + 1 : null,
    hasMore: messages.length === pageSize,
    total: await fetchTotal(env)
  });
}

async function fetchTotal(env) {
  // 用 search API 数总数（issues 接口不直接给按标签统计的总数）
  try {
    const res = await fetch(
      `${API_BASE}/search/issues?q=repo:${env.GITHUB_OWNER}/${env.GITHUB_REPO}+label:${LABEL_ALL}&per_page=1`,
      ghHeaders(env)
    );
    if (res.ok) {
      const data = await res.json();
      return data.total_count ?? 0;
    }
  } catch (e) { /* 忽略，返回 0 */ }
  return 0;
}

function issueToMessage(issue) {
  const fields = parseBody(issue.body || '');
  return {
    id: issue.number,
    name: fields.name || '匿名访客',
    content: fields.content || '',
    type: fields.type || '建议',
    time: issue.created_at,
    state: issue.state,     // open | closed
    url: issue.html_url
  };
}

function parseBody(body) {
  const get = (key) => {
    const m = body.match(new RegExp(`###\\s*${key}\\s*\\n([^\\n#]*)`));
    return m ? m[1].trim() : '';
  };
  return { name: get('昵称'), content: get('反馈内容'), type: get('反馈类型') };
}

/* ── 提交 ─────────────────────────────────────────────────── */
async function handlePost(request, env) {
  let payload;
  try { payload = await request.json(); } catch (e) { return json({ error: '请求格式错误' }, 400); }

  // 蜜罐：机器人填了隐藏字段 → 静默成功
  if (payload.hp) return json({ message: null });

  const type = TYPE_LABELS[payload.type] || TYPE_LABELS.suggestion;
  const name = String(payload.name || '').trim().slice(0, MAX_NAME);
  const content = String(payload.content || '').trim().slice(0, MAX_CONTENT);

  if (!name) return json({ error: '请填写昵称' }, 400);
  if (!content) return json({ error: '请填写反馈内容' }, 400);

  // 可选限流：每 IP 每小时 5 条
  if (env.FEEDBACK_KV) {
    const denied = await rateLimit(env, request);
    if (denied) return json({ error: '提交过于频繁，请稍后再试' }, 429);
  }

  const title = `[${type}] ${name}：${content.slice(0, 15)}${content.length > 15 ? '…' : ''}`;
  const body = [
    '### 反馈类型', type,
    '',
    '### 昵称', name,
    '',
    '### 反馈内容', content,
    '',
    '### 提交时间', new Date().toISOString().replace('T', ' ').slice(0, 19),
    '',
    '### 来源页面', '建议反馈页'
  ].join('\n');

  const res = await fetch(`${API_BASE}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: ghHeaders(env, true),
    body: JSON.stringify({ title, body, labels: [type, LABEL_ALL] })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub 提交失败 (${res.status})`);
  }
  const issue = await res.json();
  return json({ message: issueToMessage(issue) });
}

/* ── 工具 ─────────────────────────────────────────────────── */
function ghHeaders(env, post = false) {
  const h = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xylx-feedback'
  };
  if (post) h['Content-Type'] = 'application/json';
  return h;
}

async function rateLimit(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `feedback:${ip}`;
  try {
    const count = parseInt(await env.FEEDBACK_KV.get(key) || '0', 10);
    if (count >= 5) return true;
    await env.FEEDBACK_KV.put(key, String(count + 1), { expirationTtl: 3600 });
  } catch (e) { /* 限流失效不阻塞提交 */ }
  return false;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
