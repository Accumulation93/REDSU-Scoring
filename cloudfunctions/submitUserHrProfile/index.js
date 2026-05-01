const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const TEMPLATE_KEY = 'default_hr_profile_template';

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

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const [year, month, day] = value.split('-').map((item) => Number(item));
  return date.getFullYear() === year
    && date.getMonth() + 1 === month
    && date.getDate() === day;
}

function getNumericLength(value) {
  return String(value || '').replace(/^[+-]/, '').replace('.', '').length;
}

function validateFieldValue(field, rawValue) {
  const value = rawValue == null ? '' : String(rawValue).trim();

  if (field.required && !value) {
    return `${field.label}不能为空`;
  }

  if (!value) {
    return '';
  }

  if (field.type === 'text') {
    if (field.minLength != null && value.length < field.minLength) {
      return `${field.label}长度不能少于 ${field.minLength}`;
    }
    if (field.maxLength != null && value.length > field.maxLength) {
      return `${field.label}长度不能超过 ${field.maxLength}`;
    }
    return '';
  }

  if (field.type === 'number') {
    if (field.allowDecimal === false && !/^[+-]?\d+$/.test(value)) {
      return `${field.label}必须是整数`;
    }

    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return `${field.label}必须是数字`;
    }

    if (field.numberRule === 'length_range') {
      const numericLength = getNumericLength(value);
      if (field.minDigits != null && numericLength < field.minDigits) {
        return `${field.label}长度不能少于 ${field.minDigits}`;
      }
      if (field.maxDigits != null && numericLength > field.maxDigits) {
        return `${field.label}长度不能超过 ${field.maxDigits}`;
      }
    } else {
      if (field.minValue != null && numberValue < field.minValue) {
        return `${field.label}不能小于 ${field.minValue}`;
      }
      if (field.maxValue != null && numberValue > field.maxValue) {
        return `${field.label}不能大于 ${field.maxValue}`;
      }
    }
    return '';
  }

  if (field.type === 'sequence') {
    if (field.options.indexOf(value) === -1) {
      return `${field.label}必须从预设选项中选择`;
    }
    return '';
  }

  if (field.type === 'date' && !isValidDateString(value)) {
    return `${field.label}必须是有效日期`;
  }

  if (field.type === 'phone' && !/^1[3-9]\d{9}$/.test(value)) {
    return `${field.label}必须是有效手机号`;
  }

  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `${field.label}必须是有效邮箱`;
  }

  return '';
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const values = event.values && typeof event.values === 'object' ? event.values : {};

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

  const user = userRes.data[0];

  let templateDoc = null;
  try {
    const templateRes = await db.collection('hr_profile_templates')
      .where({
        templateKey: TEMPLATE_KEY
      })
      .limit(1)
      .get();
    templateDoc = templateRes.data[0] || null;
  } catch (error) {
    templateDoc = null;
  }

  if (!templateDoc) {
    return {
      status: 'missing_template',
      message: '管理员尚未配置人事信息模板'
    };
  }

  const editMode = templateDoc.editMode || 'direct';
  if (editMode === 'readonly') {
    return {
      status: 'readonly',
      message: '当前模板不允许自行修改，请联系管理员'
    };
  }

  const fields = Array.isArray(templateDoc.fields) ? templateDoc.fields.map((item) => normalizeTemplateField(item)) : [];
  const normalizedValues = {};

  for (const field of fields) {
    const rawValue = values[field.id];
    const errorMessage = validateFieldValue(field, rawValue);
    if (errorMessage) {
      return {
        status: 'invalid_params',
        message: errorMessage
      };
    }

    normalizedValues[field.id] = rawValue == null ? '' : String(rawValue).trim();
  }

  let existingRes = { data: [] };
  try {
    existingRes = await db.collection('hr_profile_records')
      .where({ hrId: user.hrId || user._id || '' })
      .limit(1)
      .get();
  } catch (error) {}

  const basePayload = {
    hrId: user.hrId || user._id || '',
    name: user.name || '',
    openid,
    templateKey: TEMPLATE_KEY,
    templateUpdatedAt: templateDoc.updatedAt || null
  };

  if (existingRes.data.length) {
    const docId = existingRes.data[0]._id;
    const currentValues = existingRes.data[0].values && typeof existingRes.data[0].values === 'object'
      ? existingRes.data[0].values
      : {};

    const updatePayload = editMode === 'audit'
      ? {
        ...basePayload,
        values: currentValues,
        pendingValues: normalizedValues,
        auditStatus: 'pending',
        rejectionReason: '',
        requestedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      : {
        ...basePayload,
        values: normalizedValues,
        pendingValues: {},
        auditStatus: 'approved',
        rejectionReason: '',
        requestedAt: null,
        reviewedAt: db.serverDate(),
        updatedAt: db.serverDate()
      };

    await db.collection('hr_profile_records')
      .doc(docId)
      .update({
        data: updatePayload
      });
  } else {
    const createPayload = editMode === 'audit'
      ? {
        ...basePayload,
        values: {},
        pendingValues: normalizedValues,
        auditStatus: 'pending',
        rejectionReason: '',
        requestedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      : {
        ...basePayload,
        values: normalizedValues,
        pendingValues: {},
        auditStatus: 'approved',
        rejectionReason: '',
        requestedAt: null,
        reviewedAt: db.serverDate(),
        updatedAt: db.serverDate()
      };

    await db.collection('hr_profile_records').add({
      data: createPayload
    });
  }

  return {
    status: 'success',
    mode: editMode,
    message: editMode === 'audit' ? '已提交审核，管理员通过后生效' : '人事信息已保存'
  };
};
