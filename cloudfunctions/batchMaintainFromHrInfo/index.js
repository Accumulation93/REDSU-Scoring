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
    const res = await query.where({}).skip(skip).limit(PAGE_SIZE).get();
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
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

function buildIdSet(rows = []) {
  return new Set(rows.map((item) => safeString(item && item._id)).filter(Boolean));
}

exports.main = async () => {
  let currentStep = '初始化';
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;

    currentStep = '校验管理员权限';
    const admin = await ensureAdmin(openid);
    if (!admin) {
      return { status: 'forbidden', message: '没有管理权限' };
    }

    currentStep = '读取人事成员和组织字典';
    const [hrRows, departmentRows, identityRows, workGroupRows] = await Promise.all([
      getAllRecords(db.collection('hr_info')),
      getAllRecords(db.collection('departments')),
      getAllRecords(db.collection('identities')),
      getAllRecords(db.collection('work_groups'))
    ]);

    const departmentIds = buildIdSet(departmentRows);
    const identityIds = buildIdSet(identityRows);
    const workGroupIds = buildIdSet(workGroupRows);
    const workGroupsById = new Map(workGroupRows.map((item) => [safeString(item._id), item]));

    const stats = {
      checkedMembers: hrRows.length,
      referencedDepartments: 0,
      referencedIdentities: 0,
      referencedWorkGroups: 0,
      missingDepartments: 0,
      missingIdentities: 0,
      missingWorkGroups: 0,
      wrongDepartmentWorkGroups: 0
    };

    const seenDepartments = new Set();
    const seenIdentities = new Set();
    const seenWorkGroups = new Set();

    currentStep = '复查组织字典完整性';
    for (const item of hrRows) {
      const departmentId = safeString(item.departmentId);
      const identityId = safeString(item.identityId);
      const workGroupId = safeString(item.workGroupId);

      if (departmentId) seenDepartments.add(departmentId);
      if (identityId) seenIdentities.add(identityId);
      if (workGroupId) seenWorkGroups.add(workGroupId);

      if (departmentId && !departmentIds.has(departmentId)) stats.missingDepartments += 1;
      if (identityId && !identityIds.has(identityId)) stats.missingIdentities += 1;
      if (workGroupId && !workGroupIds.has(workGroupId)) {
        stats.missingWorkGroups += 1;
      } else if (workGroupId) {
        const workGroup = workGroupsById.get(workGroupId);
        if (safeString(workGroup && workGroup.departmentId) !== departmentId) {
          stats.wrongDepartmentWorkGroups += 1;
        }
      }
    }

    stats.referencedDepartments = seenDepartments.size;
    stats.referencedIdentities = seenIdentities.size;
    stats.referencedWorkGroups = seenWorkGroups.size;

    if (
      stats.missingDepartments ||
      stats.missingIdentities ||
      stats.missingWorkGroups ||
      stats.wrongDepartmentWorkGroups
    ) {
      return {
        status: 'error',
        message: `组织字典未补齐：部门${stats.missingDepartments}条，身份${stats.missingIdentities}条，工作分工${stats.missingWorkGroups}条，部门不匹配工作分工${stats.wrongDepartmentWorkGroups}条`,
        stats
      };
    }

    return {
      status: 'success',
      message: '组织字典引用完整',
      stats
    };
  } catch (error) {
    const detail = safeString(error && (error.message || error.errMsg));
    return {
      status: 'error',
      message: detail ? `${currentStep}失败：${detail}` : `${currentStep}失败`
    };
  }
};
