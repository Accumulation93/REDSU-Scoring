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

exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return { status: 'forbidden', message: '没有管理权限' };
    }

    const rows = await getAllRecords(db.collection('departments')).catch(() => []);
    const departments = rows.map((item) => {
      const code = safeString(item.code || item['部门编码'] || item._id);
      return {
        id: safeString(item._id),
        key: code,
        code,
        name: safeString(item.name || item['部门名称']),
        sortOrder: toNumber(item.sortOrder == null ? item['排序顺序'] : item.sortOrder, 0),
        description: safeString(item.description || item['部门描述']),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      };
    }).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    return { status: 'success', departments };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '获取部门列表失败'
    };
  }
};
