const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function safeString(value) { return String(value == null ? '' : value).trim(); }

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const admin = await ensureAdmin(wxContext.OPENID);
    if (!admin) return { status: 'forbidden', message: '无管理权限' };

    const id = safeString(event.id);
    const name = safeString(event.name);
    const departmentId = safeString(event.departmentId);
    const description = safeString(event.description);
    if (!name) return { status: 'invalid_params', message: '请填写分工名称' };
    if (!departmentId) return { status: 'invalid_params', message: '请选择所属部门' };

    const department = await db.collection('departments').doc(departmentId).get().catch(() => ({ data: null }));
    if (!department.data) return { status: 'invalid_params', message: '部门不存在' };

    const duplicate = await db.collection('work_groups').where({ departmentId, name }).limit(10).get().catch(() => ({ data: [] }));
    if ((duplicate.data || []).some((item) => safeString(item._id) !== id)) {
      return { status: 'invalid_params', message: '同一部门下分工名称重复' };
    }

    const now = db.serverDate();
    const data = {
      name,
      departmentId,
      description,
      code: _.remove(),
      departmentCode: _.remove(),
      departmentName: _.remove(),
      sortOrder: _.remove(),
      sort_order: _.remove(),
      updatedAt: now
    };

    if (id) {
      const current = await db.collection('work_groups').doc(id).get().catch(() => ({ data: null }));
      if (!current.data) return { status: 'not_found', message: '分工不存在' };
      const oldDepartmentId = safeString(current.data.departmentId);
      if (oldDepartmentId && oldDepartmentId !== departmentId) {
        const refs = await db.collection('hr_info').where({ workGroupId: id }).limit(1).get().catch(() => ({ data: [] }));
        if ((refs.data || []).length) {
          return { status: 'in_use', message: '该分工下有人员，不能更换所属部门' };
        }
      }
      await db.collection('work_groups').doc(id).update({ data });
      return { status: 'success', id, departmentId };
    }

    const addRes = await db.collection('work_groups').add({ data: { name, departmentId, description, createdAt: now, updatedAt: now } });
    return { status: 'success', id: addRes._id, departmentId };
  } catch (error) {
    return { status: 'error', message: safeString(error && (error.message || error.errMsg)) || '保存分工失败' };
  }
};
