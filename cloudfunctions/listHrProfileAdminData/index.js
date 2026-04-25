const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const TEMPLATE_KEY = 'default_hr_profile_template';

const MODE_TEXT_MAP = {
  direct: '允许直接修改',
  audit: '需审核后生效',
  readonly: '不允许自行修改'
};

function normalizeTemplateField(field = {}) {
  return {
    id: String(field.id || '').trim(),
    label: String(field.label || '').trim(),
    type: String(field.type || 'text').trim(),
    required: field.required === true,
    minLength: field.minLength == null ? null : Number(field.minLength),
    maxLength: field.maxLength == null ? null : Number(field.maxLength),
    minValue: field.minValue == null ? null : Number(field.minValue),
    maxValue: field.maxValue == null ? null : Number(field.maxValue),
    options: Array.isArray(field.options) ? field.options.map((item) => String(item || '').trim()).filter(Boolean) : []
  };
}

function summarizeValues(fields = [], values = {}) {
  return fields
    .map((field) => {
      const value = values[field.id];
      if (value == null || value === '') {
        return '';
      }
      return `${field.label}：${value}`;
    })
    .filter(Boolean)
    .join('；');
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const operator = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return {
      status: 'forbidden',
      message: '没有管理员权限'
    };
  }

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

  const fields = templateDoc && Array.isArray(templateDoc.fields)
    ? templateDoc.fields.map((item) => normalizeTemplateField(item))
    : [];

  const hrRes = await db.collection('hr_info').limit(1000).get();
  let recordMap = new Map();
  try {
    const recordRes = await db.collection('hr_profile_records').limit(1000).get();
    recordMap = new Map((recordRes.data || []).map((item) => [String(item.studentId || ''), item]));
  } catch (error) {}

  const rows = (hrRes.data || []).map((item) => {
    const studentId = String(item.studentId || item['学号'] || '');
    const record = recordMap.get(studentId) || {};
    const values = record.values && typeof record.values === 'object' ? record.values : {};
    const pendingValues = record.pendingValues && typeof record.pendingValues === 'object' ? record.pendingValues : {};
    const auditStatus = record.auditStatus || 'none';

    return {
      id: studentId || item._id,
      recordId: record._id || '',
      name: item.name || item['姓名'] || '',
      studentId,
      department: item.department || item['所属部门'] || '',
      identity: item.identity || item['身份'] || '',
      workGroup: item.workGroup || item['工作分工（职能组）'] || '',
      currentSummary: summarizeValues(fields, values) || '暂无扩展资料',
      pendingSummary: summarizeValues(fields, pendingValues),
      auditStatus,
      auditStatusText: auditStatus === 'pending'
        ? '待审核'
        : auditStatus === 'approved'
          ? '已生效'
          : auditStatus === 'rejected'
            ? '已驳回'
            : '未提交',
      rejectionReason: record.rejectionReason || '',
      hasPending: auditStatus === 'pending' && !!Object.keys(pendingValues).length
    };
  }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));

  return {
    status: 'success',
    template: templateDoc ? {
      description: templateDoc.description || '',
      editMode: templateDoc.editMode || 'direct',
      modeText: MODE_TEXT_MAP[templateDoc.editMode || 'direct'] || MODE_TEXT_MAP.direct,
      fields
    } : null,
    rows
  };
};
