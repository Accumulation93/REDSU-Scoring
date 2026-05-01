const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const TEMPLATE_KEY = 'default_hr_profile_template';
const PAGE_SIZE = 100;

const MODE_TEXT_MAP = {
  direct: '允许直接修改',
  audit: '需审核后生效',
  readonly: '不允许自行修改'
};

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function getAllRecords(collectionName) {
  const list = [];
  let skip = 0;
  while (true) {
    const res = await db.collection(collectionName).where({}).skip(skip).limit(PAGE_SIZE).get().catch(() => ({ data: [] }));
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }
  return list;
}

function buildOrgMap(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const id = safeString(row && row._id);
    if (!id) return;
    map.set(id, safeString(row.name));
  });
  return map;
}

function lookupName(map, id) {
  return (map && map.get(safeString(id))) || '';
}

function normalizeHrRecord(item = {}, orgLookups = {}) {
  const departmentId = safeString(item.departmentId);
  const identityId = safeString(item.identityId);
  const workGroupId = safeString(item.workGroupId);
  return {
    id: safeString(item._id),
    name: safeString(item.name),
    studentId: safeString(item.studentId),
    department: lookupName(orgLookups.departmentsById, departmentId),
    identity: lookupName(orgLookups.identitiesById, identityId),
    workGroup: lookupName(orgLookups.workGroupsById, workGroupId)
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

function getAuditStatusText(auditStatus) {
  if (auditStatus === 'pending') return '待审核';
  if (auditStatus === 'approved') return '已生效';
  if (auditStatus === 'rejected') return '已驳回';
  return '未提交';
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

  const [templateDoc, hrRes, recordRes, orgLookups] = await Promise.all([
    db.collection('hr_profile_templates')
      .where({ templateKey: TEMPLATE_KEY })
      .limit(1)
      .get()
      .then((res) => res.data[0] || null)
      .catch(() => null),
    db.collection('hr_info').limit(1000).get(),
    db.collection('hr_profile_records').limit(1000).get().catch(() => ({ data: [] })),
    Promise.all([
      getAllRecords('departments'),
      getAllRecords('identities'),
      getAllRecords('work_groups')
    ]).then(([departments, identities, workGroups]) => ({
      departmentsById: buildOrgMap(departments),
      identitiesById: buildOrgMap(identities),
      workGroupsById: buildOrgMap(workGroups)
    }))
  ]);

  const fields = templateDoc && Array.isArray(templateDoc.fields)
    ? templateDoc.fields.map((item) => normalizeTemplateField(item))
    : [];

  const recordMap = new Map((recordRes.data || []).map((item) => [safeString(item.hrId), item]));

  const rows = (hrRes.data || []).map((item) => {
    const hr = normalizeHrRecord(item, orgLookups);
    const record = recordMap.get(hr.id) || {};
    const values = record.values && typeof record.values === 'object' ? record.values : {};
    const pendingValues = record.pendingValues && typeof record.pendingValues === 'object' ? record.pendingValues : {};
    const auditStatus = safeString(record.auditStatus || 'none') || 'none';

    return {
      id: hr.id,
      recordId: safeString(record._id),
      name: hr.name,
      studentId: hr.studentId,
      department: hr.department,
      identity: hr.identity,
      workGroup: hr.workGroup,
      currentSummary: summarizeValues(fields, values) || '暂无扩展资料',
      pendingSummary: summarizeValues(fields, pendingValues),
      auditStatus,
      auditStatusText: getAuditStatusText(auditStatus),
      rejectionReason: safeString(record.rejectionReason),
      hasPending: auditStatus === 'pending' && Object.keys(pendingValues).length > 0
    };
  });

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
