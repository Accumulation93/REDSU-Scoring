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
        message: '工作分工ID不能为空'
      };
    }

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return {
        status: 'forbidden',
        message: '没有管理权限'
      };
    }

    const workGroupRes = await db.collection('work_groups').doc(id).get().catch(() => ({ data: null }));
    if (!workGroupRes.data) {
      return {
        status: 'not_found',
        message: '工作分工不存在'
      };
    }

    const workGroupName = safeString(workGroupRes.data.name || workGroupRes.data.工作分工名称);
    const departmentId = safeString(workGroupRes.data.departmentId || workGroupRes.data.所属部门ID);
    const departmentRes = departmentId
      ? await db.collection('departments').doc(departmentId).get().catch(() => ({ data: null }))
      : { data: null };
    const departmentName = safeString(departmentRes.data && (departmentRes.data.name || departmentRes.data.部门名称));
    const hrRes = await db.collection('hr_info')
      .where({ department: departmentName, workGroup: workGroupName })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));

    if ((hrRes.data || []).length) {
      return {
        status: 'in_use',
        message: '该工作分工已被人事成员引用，不能删除'
      };
    }
    const hrRows = await getAllRecords(db.collection('hr_info')).catch(() => []);
    if (hrRows.some((item) => (
      safeString(item.department || item['所属部门']) === departmentName
      && safeString(item.workGroup || item['工作分工（职能组）']) === workGroupName
    ))) {
      return {
        status: 'in_use',
        message: '该工作分工已被人事成员引用，不能删除'
      };
    }

    const rules = await getAllRecords(db.collection('rate_target_rules')).catch(() => []);
    const referencedByRule = rules.some((rule) => (
      safeString(rule.scorerDepartment) === departmentName
      && Array.isArray(rule.clauses)
      && rule.clauses.some((clause) => safeString(clause.scopeType).includes('same_work_group'))
    ));
    if (referencedByRule) {
      return {
        status: 'in_use',
        message: '该工作分工所在部门存在同职能组评分规则，不能删除'
      };
    }

    await db.collection('work_groups').doc(id).remove();

    return {
      status: 'success',
      message: '工作分工删除成功'
    };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '删除工作分工失败'
    };
  }
};
