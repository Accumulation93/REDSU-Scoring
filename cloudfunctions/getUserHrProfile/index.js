const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const TEMPLATE_KEY = 'default_hr_profile_template';
const MODE_TEXT_MAP = {
  direct: '允许直接修改',
  audit: '修改后需管理员审核',
  readonly: '当前不允许自行修改'
};

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function getOrgName(collectionName, id) {
  const safeId = safeString(id);
  if (!safeId) return '';
  const res = await db.collection(collectionName).doc(safeId).get().catch(() => ({ data: null }));
  return safeString(res.data && res.data.name);
}

async function normalizeUser(record = {}) {
  const departmentId = safeString(record.departmentId);
  const identityId = safeString(record.identityId);
  const workGroupId = safeString(record.workGroupId);
  const [department, identity, workGroup] = await Promise.all([
    getOrgName('departments', departmentId),
    getOrgName('identities', identityId),
    getOrgName('work_groups', workGroupId)
  ]);

  return {
    id: safeString(record._id),
    name: safeString(record.name),
    studentId: safeString(record.studentId),
    departmentId,
    department,
    identityId,
    identity,
    workGroupId,
    workGroup
  };
}

function normalizeTemplateField(field = {}) {
  return {
    id: safeString(field.id),
    label: safeString(field.label),
    type: safeString(field.type || 'text'),
    required: field.required === true,
    minLength: field.minLength == null ? null : Number(field.minLength),
    maxLength: field.maxLength == null ? null : Number(field.maxLength),
    numberRule: safeString(field.numberRule || 'value_range'),
    allowDecimal: field.allowDecimal !== false,
    minDigits: field.minDigits == null ? null : Number(field.minDigits),
    maxDigits: field.maxDigits == null ? null : Number(field.maxDigits),
    minValue: field.minValue == null ? null : Number(field.minValue),
    maxValue: field.maxValue == null ? null : Number(field.maxValue),
    options: Array.isArray(field.options) ? field.options.map((item) => safeString(item)).filter(Boolean) : []
  };
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const userRes = await db.collection('user_info')
    .where({ openid })
    .limit(1)
    .get();

  if (!userRes.data.length) {
    return {
      status: 'user_not_found',
      message: '未找到当前用户信息，请重新登录'
    };
  }

  const hrId = safeString(userRes.data[0].hrId);
  if (!hrId) {
    return {
      status: 'user_not_found',
      message: '当前用户未绑定人事成员'
    };
  }

  const hrRes = await db.collection('hr_info').doc(hrId).get().catch(() => ({ data: null }));
  if (!hrRes.data) {
    return {
      status: 'user_not_found',
      message: '绑定的人事成员不存在，请重新绑定'
    };
  }

  let templateDoc = null;
  try {
    const templateRes = await db.collection('hr_profile_templates')
      .where({ templateKey: TEMPLATE_KEY })
      .limit(1)
      .get();
    templateDoc = templateRes.data[0] || null;
  } catch (error) {}

  const template = templateDoc ? {
    description: templateDoc.description || '',
    editMode: templateDoc.editMode || 'direct',
    modeText: MODE_TEXT_MAP[templateDoc.editMode || 'direct'] || MODE_TEXT_MAP.direct,
    fields: Array.isArray(templateDoc.fields) ? templateDoc.fields.map((item) => normalizeTemplateField(item)) : []
  } : null;

  let record = null;
  try {
    const recordRes = await db.collection('hr_profile_records')
      .where({ hrId })
      .limit(1)
      .get();
    record = recordRes.data[0] || null;
  } catch (error) {}

  const values = record && record.values && typeof record.values === 'object' ? record.values : {};
  const pendingValues = record && record.pendingValues && typeof record.pendingValues === 'object' ? record.pendingValues : {};
  const auditStatus = record && record.auditStatus ? record.auditStatus : 'none';
  const rejectionReason = record && record.rejectionReason ? String(record.rejectionReason) : '';

  return {
    status: 'success',
    profile: await normalizeUser(hrRes.data),
    template,
    values,
    pendingValues,
    auditStatus,
    rejectionReason,
    statusText: auditStatus === 'pending'
      ? '已提交待审核'
      : auditStatus === 'rejected'
        ? '上次申请未通过'
        : auditStatus === 'approved'
          ? '资料已保存'
          : '尚未提交扩展资料'
  };
};
