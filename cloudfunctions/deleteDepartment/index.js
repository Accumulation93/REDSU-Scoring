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
        message: '部门ID不能为空'
      };
    }

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return {
        status: 'forbidden',
        message: '没有管理权限'
      };
    }

    const departmentRes = await db.collection('departments').doc(id).get().catch(() => ({ data: null }));
    if (!departmentRes.data) {
      return {
        status: 'not_found',
        message: '部门不存在'
      };
    }

    const departmentName = safeString(departmentRes.data.name || departmentRes.data.部门名称);
    const [hrRes, workGroupRes, ruleRes] = await Promise.all([
      db.collection('hr_info').where({ department: departmentName }).limit(1).get().catch(() => ({ data: [] })),
      db.collection('work_groups').where({ departmentId: id }).limit(1).get().catch(() => ({ data: [] })),
      db.collection('rate_target_rules').where({ scorerDepartment: departmentName }).limit(1).get().catch(() => ({ data: [] }))
    ]);

    if ((hrRes.data || []).length) {
      return {
        status: 'in_use',
        message: '该部门已被人事成员引用，不能删除'
      };
    }
    const hrRows = await getAllRecords(db.collection('hr_info')).catch(() => []);
    if (hrRows.some((item) => safeString(item.department || item['所属部门']) === departmentName)) {
      return {
        status: 'in_use',
        message: '该部门已被人事成员引用，不能删除'
      };
    }
    if ((workGroupRes.data || []).length) {
      return {
        status: 'in_use',
        message: '该部门下还有工作分工，不能删除'
      };
    }
    if ((ruleRes.data || []).length) {
      return {
        status: 'in_use',
        message: '该部门已被评分规则引用，不能删除'
      };
    }

    const rules = await getAllRecords(db.collection('rate_target_rules')).catch(() => []);
    const referencedByClause = rules.some((rule) => (
      Array.isArray(rule.clauses)
      && rule.clauses.some((clause) => safeString(clause.scopeType).includes('same_department'))
      && safeString(rule.scorerDepartment) === departmentName
    ));
    if (referencedByClause) {
      return {
        status: 'in_use',
        message: '该部门已被评分规则引用，不能删除'
      };
    }

    await db.collection('departments').doc(id).remove();

    return {
      status: 'success',
      message: '部门删除成功'
    };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '删除部门失败'
    };
  }
};
