const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const TEMPLATE_KEY = 'default_hr_profile_template';
const EDIT_MODES = ['direct', 'audit', 'readonly'];
const FIELD_TYPES = ['text', 'number', 'sequence', 'date', 'phone', 'email'];
const NUMBER_RULE_TYPES = ['value_range', 'length_range'];

function normalizeField(field = {}, index = 0) {
  const id = String(field.id || `field_${Date.now()}_${index}`).trim();
  const label = String(field.label || '').trim();
  const type = String(field.type || 'text').trim();
  const required = field.required === true;
  const minLength = field.minLength === '' || field.minLength == null ? null : Number(field.minLength);
  const maxLength = field.maxLength === '' || field.maxLength == null ? null : Number(field.maxLength);
  const numberRule = String(field.numberRule || 'value_range').trim();
  const allowDecimal = field.allowDecimal !== false;
  const minDigits = field.minDigits === '' || field.minDigits == null ? null : Number(field.minDigits);
  const maxDigits = field.maxDigits === '' || field.maxDigits == null ? null : Number(field.maxDigits);
  const minValue = field.minValue === '' || field.minValue == null ? null : Number(field.minValue);
  const maxValue = field.maxValue === '' || field.maxValue == null ? null : Number(field.maxValue);
  const options = Array.isArray(field.options)
    ? field.options.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  return {
    id,
    label,
    type,
    required,
    minLength: Number.isFinite(minLength) ? minLength : null,
    maxLength: Number.isFinite(maxLength) ? maxLength : null,
    numberRule: NUMBER_RULE_TYPES.includes(numberRule) ? numberRule : 'value_range',
    allowDecimal,
    minDigits: Number.isFinite(minDigits) ? minDigits : null,
    maxDigits: Number.isFinite(maxDigits) ? maxDigits : null,
    minValue: Number.isFinite(minValue) ? minValue : null,
    maxValue: Number.isFinite(maxValue) ? maxValue : null,
    options
  };
}

function validateField(field = {}) {
  if (!field.label) {
    return '字段名称不能为空';
  }

  if (!FIELD_TYPES.includes(field.type)) {
    return '字段类型不合法';
  }

  if (field.type === 'text') {
    if (field.minLength != null && field.minLength < 0) {
      return '文本最短长度不能小于 0';
    }
    if (field.maxLength != null && field.maxLength <= 0) {
      return '文本最大长度必须大于 0';
    }
    if (field.minLength != null && field.maxLength != null && field.minLength > field.maxLength) {
      return '文本最短长度不能大于最大长度';
    }
  }

  if (field.type === 'number') {
    if (!NUMBER_RULE_TYPES.includes(field.numberRule)) {
      return '数字限制方式不合法';
    }
    if (field.minDigits != null && field.minDigits < 0) {
      return '数字最短长度不能小于 0';
    }
    if (field.maxDigits != null && field.maxDigits <= 0) {
      return '数字最长长度必须大于 0';
    }
    if (field.minDigits != null && field.maxDigits != null && field.minDigits > field.maxDigits) {
      return '数字最短长度不能大于最长长度';
    }
    if (field.numberRule === 'value_range' && field.minValue != null && field.maxValue != null && field.minValue > field.maxValue) {
      return '数字最小值不能大于最大值';
    }
  }

  if (field.type === 'sequence' && !field.options.length) {
    return '序列字段至少需要一个可选项';
  }

  return '';
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const description = String(event.description || '').trim();
  const editMode = String(event.editMode || 'direct').trim();
  const fields = Array.isArray(event.fields) ? event.fields : [];

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

  if (!EDIT_MODES.includes(editMode)) {
    return {
      status: 'invalid_params',
      message: '编辑模式不合法'
    };
  }

  const normalizedFields = fields.map((field, index) => normalizeField(field, index));
  if (!normalizedFields.length) {
    return {
      status: 'invalid_params',
      message: '至少需要配置一个字段'
    };
  }

  const fieldIdSet = new Set();
  for (const field of normalizedFields) {
    if (fieldIdSet.has(field.id)) {
      return {
        status: 'invalid_params',
        message: '字段标识重复，请刷新后重试'
      };
    }
    fieldIdSet.add(field.id);

    const errorMessage = validateField(field);
    if (errorMessage) {
      return {
        status: 'invalid_params',
        message: `${field.label || '未命名字段'}：${errorMessage}`
      };
    }
  }

  const payload = {
    templateKey: TEMPLATE_KEY,
    description,
    editMode,
    fields: normalizedFields,
    updatedAt: db.serverDate(),
    updatedBy: operator.data[0]._id
  };

  const existing = await db.collection('hr_profile_templates')
    .where({
      templateKey: TEMPLATE_KEY
    })
    .limit(1)
    .get();

  if (existing.data.length) {
    await db.collection('hr_profile_templates')
      .doc(existing.data[0]._id)
      .update({
        data: payload
      });
  } else {
    await db.collection('hr_profile_templates').add({
      data: payload
    });
  }

  return {
    status: 'success',
    template: {
      description,
      editMode,
      fields: normalizedFields
    }
  };
};
