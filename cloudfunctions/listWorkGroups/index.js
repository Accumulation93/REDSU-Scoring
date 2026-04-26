const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PAGE_SIZE = 100;

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function getAllRecords(query) {
  const list = [];
  let skip = 0;

  while (true) {
    const res = await query.skip(skip).limit(PAGE_SIZE).get();
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

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const departmentRef = safeString(event.departmentCode || event.departmentId);

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return { status: 'forbidden', message: '没有管理权限' };
    }

    const departments = await getAllRecords(db.collection('departments')).catch(() => []);
    const departmentsById = new Map();
    const departmentsByCode = new Map();
    departments.forEach((item) => {
      const id = safeString(item._id);
      const code = safeString(item.code || item['部门编码'] || item._id);
      const name = safeString(item.name || item['部门名称']);
      if (id) departmentsById.set(id, { id, code, name });
      if (code) departmentsByCode.set(code, { id, code, name });
    });

    const rows = await getAllRecords(db.collection('work_groups')).catch(() => []);
    const workGroups = rows.map((item) => {
      const code = safeString(item.code || item['工作分工编码'] || item._id);
      const departmentId = safeString(item.departmentId || item['所属部门ID']);
      const departmentCode = safeString(item.departmentCode || item['所属部门编码']);
      const department = departmentsByCode.get(departmentCode) || departmentsById.get(departmentId) || {};
      return {
        id: safeString(item._id),
        key: code,
        code,
        name: safeString(item.name || item['工作分工名称']),
        departmentId,
        departmentCode: departmentCode || safeString(department.code),
        departmentName: safeString(item.departmentName || item['所属部门名称'] || department.name),
        sortOrder: toNumber(item.sortOrder == null ? item['排序顺序'] : item.sortOrder, 0),
        description: safeString(item.description || item['工作分工描述']),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      };
    }).filter((item) => {
      if (!departmentRef) return true;
      return item.departmentId === departmentRef || item.departmentCode === departmentRef;
    }).sort((a, b) => {
      const deptCompare = (a.departmentName || a.departmentCode || a.departmentId)
        .localeCompare(b.departmentName || b.departmentCode || b.departmentId, 'zh-CN');
      if (deptCompare !== 0) return deptCompare;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    return { status: 'success', workGroups };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '获取工作分工列表失败'
    };
  }
};
