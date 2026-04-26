const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PAGE_SIZE = 100;

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function getAllRecords(query) {
  const list = [];
  let skip = 0;

  while (true) {
    const res = await query.skip(skip).limit(PAGE_SIZE).get();
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
    skip += batch.length;
  }

  return list;
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const id = safeString(event.id);

    if (!id) {
      return {
        status: 'invalid_params',
        message: '身份类别ID不能为空'
      };
    }

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return {
        status: 'forbidden',
        message: '没有管理权限'
      };
    }

    const identityRes = await db.collection('identities').doc(id).get().catch(() => ({ data: null }));
    if (!identityRes.data) {
      return {
        status: 'not_found',
        message: '身份类别不存在'
      };
    }

    const identityName = safeString(identityRes.data.name || identityRes.data.身份类别名称);
    const [hrRes, scorerRuleRes] = await Promise.all([
      db.collection('hr_info').where({ identity: identityName }).limit(1).get().catch(() => ({ data: [] })),
      db.collection('rate_target_rules').where({ scorerIdentity: identityName }).limit(1).get().catch(() => ({ data: [] }))
    ]);

    if ((hrRes.data || []).length) {
      return {
        status: 'in_use',
        message: '该身份类别已被人事成员引用，不能删除'
      };
    }
    const hrRows = await getAllRecords(db.collection('hr_info')).catch(() => []);
    if (hrRows.some((item) => safeString(item.identity || item['身份']) === identityName)) {
      return {
        status: 'in_use',
        message: '该身份类别已被人事成员引用，不能删除'
      };
    }
    if ((scorerRuleRes.data || []).length) {
      return {
        status: 'in_use',
        message: '该身份类别已被评分规则引用，不能删除'
      };
    }

    const rules = await getAllRecords(db.collection('rate_target_rules')).catch(() => []);
    const referencedByClause = rules.some((rule) => (
      Array.isArray(rule.clauses)
      && rule.clauses.some((clause) => safeString(clause.targetIdentity) === identityName)
    ));
    if (referencedByClause) {
      return {
        status: 'in_use',
        message: '该身份类别已被评分规则引用，不能删除'
      };
    }

    await db.collection('identities').doc(id).remove();

    return {
      status: 'success',
      message: '身份类别删除成功'
    };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '删除身份类别失败'
    };
  }
};
