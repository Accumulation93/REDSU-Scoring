const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
}

async function getAllRecords(query) {
  const list = [];
  let skip = 0;
  while (true) {
    const res = await query.where({}).skip(skip).limit(100).get();
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < 100) break;
    skip += batch.length;
  }
  return list;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const id = safeString(event.id);
    if (!id) return { status: 'invalid_params', message: '身份类别ID不能为空' };
    const admin = await ensureAdmin(wxContext.OPENID);
    if (!admin) return { status: 'forbidden', message: '没有管理权限' };

    const current = await db.collection('identities').doc(id).get().catch(() => ({ data: null }));
    if (!current.data) return { status: 'not_found', message: '身份类别不存在' };

    const [hrRes, ruleRes] = await Promise.all([
      db.collection('hr_info').where({ identityId: id }).limit(1).get().catch(() => ({ data: [] })),
      db.collection('rate_target_rules').where({ scorerIdentityId: id }).limit(1).get().catch(() => ({ data: [] }))
    ]);
    if ((hrRes.data || []).length) return { status: 'in_use', message: '该身份类别已被人事成员引用，不能删除' };
    if ((ruleRes.data || []).length) return { status: 'in_use', message: '该身份类别已被评分规则引用，不能删除' };

    const rules = await getAllRecords(db.collection('rate_target_rules')).catch(() => []);
    if (rules.some((rule) => (rule.clauses || []).some((clause) => safeString(clause.targetIdentityId) === id))) {
      return { status: 'in_use', message: '该身份类别已被评分规则引用，不能删除' };
    }

    await db.collection('identities').doc(id).remove();
    return { status: 'success', message: '身份类别删除成功' };
  } catch (error) {
    return { status: 'error', message: safeString(error && (error.message || error.errMsg)) || '删除身份类别失败' };
  }
};
