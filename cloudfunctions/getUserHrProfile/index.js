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

function normalizeUser(record = {}) {
  return {
    id: record._id || '',
    name: record.name || record['姓名'] || '',
    studentId: record.studentId || record['学号'] || '',
    department: record.department || record['所属部门'] || '',
    identity: record.identity || record['身份'] || '',
    workGroup: record.workGroup || record['工作分工（职能组）'] || ''
  };
}

function normalizeTemplateField(field = {}) {
  return {
    id: String(field.id || '').trim(),
    label: String(field.label || '').trim(),
    type: String(field.type || 'text').trim(),
    required: field.required === true,
    minLength: field.minLength == null ? null : Number(field.minLength),
    maxLength: field.maxLength == null ? null : Number(field.maxLength),
    numberRule: String(field.numberRule || 'value_range').trim(),
    allowDecimal: field.allowDecimal !== false,
    minDigits: field.minDigits == null ? null : Number(field.minDigits),
    maxDigits: field.maxDigits == null ? null : Number(field.maxDigits),
    minValue: field.minValue == null ? null : Number(field.minValue),
    maxValue: field.maxValue == null ? null : Number(field.maxValue),
    options: Array.isArray(field.options) ? field.options.map((item) => String(item || '').trim()).filter(Boolean) : []
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

  const user = normalizeUser(userRes.data[0]);
  const hrRes = await db.collection('hr_info')
    .where({
      学号: user.studentId
    })
    .limit(1)
    .get();

  const hrProfile = hrRes.data.length ? normalizeUser(hrRes.data[0]) : user;

  let templateDoc = null;
  try {
    const templateRes = await db.collection('hr_profile_templates')
      .where({
        templateKey: TEMPLATE_KEY
      })
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
      .where({
        studentId: user.studentId
      })
      .limit(1)
      .get();
    record = recordRes.data[0] || null;
  } catch (error) {}

  const values = record && record.values && typeof record.values === 'object' ? record.values : {};
  const pendingValues = record && record.pendingValues && typeof record.pendingValues === 'object' ? record.pendingValues : {};
  const status = record && record.auditStatus ? record.auditStatus : 'none';
  const rejectionReason = record && record.rejectionReason ? String(record.rejectionReason) : '';

  return {
    status: 'success',
    profile: hrProfile,
    template,
    values,
    pendingValues,
    auditStatus: status,
    rejectionReason,
    statusText: status === 'pending'
      ? '已提交待审核'
      : status === 'rejected'
        ? '上次申请未通过'
        : status === 'approved'
          ? '资料已保存'
          : '尚未提交扩展资料'
  };
};
