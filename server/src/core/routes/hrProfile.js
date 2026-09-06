const localeCopy = require('../../locales/zh-CN/generated/core/routes/hrProfile');
const retiredCopy = require('../../locales/zh-CN/generated/core/routes/admin');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const { format: localeFormat } = require('../../locales/runtime');
const express = require('express');
const router = express.Router();
const { createNotification } = require('../../modules/audit/utils/notificationHelper');
const { safeString, generateId, buildNameMap, normalizeEmptyValue } = require('../../utils/helpers');
const { nowMysqlUtc } = require('../../utils/dateTime');
const { getCurrentOrgId } = require('../../utils/orgContext');
const { resolveCurrentAdmin } = require('../services/adminRequestContext');
const { resolveSelfHrProfileSubject } = require('../services/selfHrProfileSubject');
const hrInfoModel = require('../models/hrInfo');
const departmentModel = require('../models/department');
const identityModel = require('../models/identity');
const workGroupModel = require('../models/workGroup');
const profileTemplateModel = require('../models/hrProfileTemplate');
const profileFieldModel = require('../models/hrProfileField');
const profileRecordModel = require('../models/hrProfileRecord');
const profileValueModel = require('../models/hrProfileValue');
const profileReviewEventModel = require('../models/hrProfileReviewEvent');
const personProfileValueModel = require('../models/personProfileValue');
const templateLibrary = require('../services/hrProfileTemplateLibrary');
const { loadEffectivePermissions, hasAnyPermission } = require('../services/adminPermissions');
const { resolveHrBindingStates } = require('../services/userBindingStatus');
const { countUserCharacters } = require('../services/hrDomainPolicy');
const unifiedIdentityModel = require('../models/unifiedIdentity');
const personIdentityOverviewModel = require('../models/personIdentityOverview');
const pool = require('../../config/db');

const TEMPLATE_KEY = 'default_hr_profile_template';
const MODE_TEXT_MAP = {
  direct: personnelCopy.profileModeDirect,
  audit: personnelCopy.profileModeAudit,
  readonly: personnelCopy.profileModeReadonly
};
const PROFILE_STATUS_TEXT = {
  pending: personnelCopy.profileStatusPending,
  rejected: personnelCopy.profileStatusRejected,
  approved: personnelCopy.profileStatusApproved
};

function sendHrProfileFailure(req, res, error) {
  if (req.logger) {
    req.logger.error('HR profile operation failed', {
      event: 'hr.profile.operation_failed',
      endpoint: safeString(req.path),
      code: safeString(error && error.code),
      error: safeString(error && error.message)
    });
  }
  return res.status(500).json({
    status: 'error',
    message: personnelCopy.hrProfileOperationFailed
  });
}

function parseJsonObject(value) {
  if (!value) return {};
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = value ? JSON.parse(String(value)) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function profileFieldResponse(field, historical) {
  return {
    id: safeString(field.id),
    label: safeString(field.label),
    type: safeString(field.type || 'text'),
    required: historical ? false : Boolean(field.required),
    minLength: field.min_length,
    maxLength: field.max_length,
    numberRule: field.number_rule,
    allowDecimal: Boolean(field.allow_decimal),
    minDigits: field.min_digits,
    maxDigits: field.max_digits,
    minValue: field.min_value,
    maxValue: field.max_value,
    options: parseJsonArray(field.options_json),
    historical: Boolean(historical)
  };
}

async function ensureAdmin(req) {
  return req.admin || await resolveCurrentAdmin(req);
}

async function ensureTemplatePermission(req, permissionKeys) {
  const admin = await ensureAdmin(req);
  if (!admin) return null;
  const orgId = await getCurrentOrgId();
  const effective = req.adminPermissions || await loadEffectivePermissions(admin, orgId);
  if (!hasAnyPermission(effective, permissionKeys)) return null;
  return { admin, orgId, effective };
}

function normalizeTemplateField(field) {
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

function tryParseDate(rawValue) {
  const value = (rawValue == null ? '' : String(rawValue)).trim();
  if (!value) return null;
  const match = value.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (month >= 1 && month <= 12 && day >= 1) {
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day <= daysInMonth) {
        return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      }
    }
  }
  return null;
}

function validateFieldValue(field, rawValue, isAdmin) {
  const value = normalizeEmptyValue(rawValue);
  if (field.required && !value && !isAdmin) return localeFormat(localeCopy.copy_377d9cc43d, [field.label]);
  if (!value) return '';
  if (field.type === 'text') {
    const characterCount = countUserCharacters(value);
    if (field.minLength != null && characterCount < field.minLength) return localeFormat(localeCopy.copy_245abb6cb3, [field.label, field.minLength]);
    if (field.maxLength != null && characterCount > field.maxLength) return localeFormat(localeCopy.copy_0d42479c01, [field.label, field.maxLength]);
    return '';
  }
  if (field.type === 'number') {
    if (field.allowDecimal === false && !/^[+-]?\d+$/.test(value)) return localeFormat(localeCopy.copy_25da4c9917, [field.label]);
    const num = Number(value);
    if (!Number.isFinite(num)) return localeFormat(localeCopy.copy_803a916bfb, [field.label]);
    if (field.numberRule === 'length_range') {
      const nlen = String(value).replace(/^[+-]/, '').replace('.', '').length;
      if (field.minDigits != null && nlen < field.minDigits) return localeFormat(localeCopy.copy_8d415deaa0, [field.label, field.minDigits]);
      if (field.maxDigits != null && nlen > field.maxDigits) return localeFormat(localeCopy.copy_8ce15854f9, [field.label, field.maxDigits]);
    } else {
      if (field.minValue != null && num < field.minValue) return localeFormat(localeCopy.copy_2c1cbd4cee, [field.label, field.minValue]);
      if (field.maxValue != null && num > field.maxValue) return localeFormat(localeCopy.copy_3f2df8f2ed, [field.label, field.maxValue]);
    }
    return '';
  }
  if (field.type === 'sequence') { if (field.options.indexOf(value) === -1) return localeFormat(localeCopy.copy_02808711c5, [field.label]); return ''; }
  if (field.type === 'date' && !tryParseDate(value)) return localeFormat(localeCopy.copy_c8aa4ca152, [field.label]);
  if (field.type === 'phone' && !/^1[3-9]\d{9}$/.test(value)) return localeFormat(localeCopy.copy_e840878ac4, [field.label]);
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return localeFormat(localeCopy.copy_f117197c23, [field.label]);
  return '';
}

function profileCompleteness(fields, effectiveValues, pendingValues, auditStatus) {
  const source = auditStatus === 'pending' && Object.keys(pendingValues || {}).length
    ? pendingValues
    : effectiveValues;
  const missingRequiredFieldIds = (fields || [])
    .filter((field) => field.required)
    .filter((field) => !safeString(source && source[field.id]))
    .map((field) => field.id);
  return {
    isComplete: missingRequiredFieldIds.length === 0,
    missingRequiredFieldIds
  };
}

async function enrichHrWithOrg(hr) {
  if (!hr) return null;
  const [departments, identities, workGroups] = await Promise.all([
    departmentModel.getAll(), identityModel.getAll(), workGroupModel.getAll()
  ]);
  const deptMap = buildNameMap(departments);
  const identMap = buildNameMap(identities);
  const wgMap = buildNameMap(workGroups);
  return {
    id: hr.id, name: safeString(hr.name), studentId: safeString(hr.student_id),
    personId: safeString(hr.person_id),
    membershipId: safeString(hr.membership_id),
    membershipStatus: safeString(hr.membership_status) || 'active',
    joinedAt: hr.joined_at || null,
    leftAt: hr.left_at || null,
    departmentId: safeString(hr.department_id), department: deptMap.get(safeString(hr.department_id)) || '',
    identityId: safeString(hr.identity_id), identity: identMap.get(safeString(hr.identity_id)) || '',
    workGroupId: safeString(hr.work_group_id), workGroup: wgMap.get(safeString(hr.work_group_id)) || ''
  };
}

// getUserHrProfile
router.post('/getUserHrProfile', async (req, res) => {
  try {
    const subject = await resolveSelfHrProfileSubject(req);
    if (subject.status !== 'success') return res.json(subject);
    const { hr, personId } = subject;

    const template = await profileTemplateModel.getByTemplateKey(TEMPLATE_KEY);
    const templateData = template ? {
      description: template.description || '',
      editMode: template.edit_mode || 'direct',
      modeText: MODE_TEXT_MAP[template.edit_mode || 'direct'] || MODE_TEXT_MAP.direct,
      fields: template.id
        ? (await profileFieldModel.getByTemplateId(template.id)).map((f) => ({
            id: f.id, label: f.label, type: f.type, required: !!f.required,
            minLength: f.min_length, maxLength: f.max_length,
            numberRule: f.number_rule, allowDecimal: !!f.allow_decimal,
            minDigits: f.min_digits, maxDigits: f.max_digits,
            minValue: f.min_value, maxValue: f.max_value,
            options: f.options_json ? JSON.parse(f.options_json) : []
          }))
        : []
    } : null;

    const record = await profileRecordModel.getByHrId(hr.id);
    const activeFieldIds = new Set(templateData ? templateData.fields.map((field) => field.id) : []);
    let values = {};
    let pendingValues = {};
    if (record) {
      const [vals, pvals] = await Promise.all([
        profileValueModel.getByRecordIdAndPending(record.id, 0),
        profileValueModel.getByRecordIdAndPending(record.id, 1)
      ]);
      vals.forEach((v) => { if (activeFieldIds.has(v.field_id)) values[v.field_id] = v.field_value; });
      pvals.forEach((v) => { if (activeFieldIds.has(v.field_id)) pendingValues[v.field_id] = v.field_value; });
    }
    if (templateData && templateData.fields.length) {
      const globalRows = await personProfileValueModel.listForPerson(personId);
      const globalValues = personProfileValueModel.mapRows(globalRows);
      templateData.fields.forEach((field) => {
        const shared = globalValues[personProfileValueModel.key(field.label, field.type)];
        if (shared) values[field.id] = shared.field_value == null ? '' : String(shared.field_value);
      });
    }

    const auditStatus = record ? (record.audit_status || 'none') : 'none';
    const rejectionReason = record ? (record.rejection_reason || '') : '';
    const completeness = profileCompleteness(
      templateData ? templateData.fields : [], values, pendingValues, auditStatus
    );

    res.json({
      status: 'success',
      profile: await enrichHrWithOrg(hr),
      template: templateData,
      values, pendingValues, auditStatus, rejectionReason,
      isComplete: completeness.isComplete,
      missingRequiredFieldIds: completeness.missingRequiredFieldIds,
      statusText: PROFILE_STATUS_TEXT[auditStatus] || localeCopy.copy_ede4536b9a
    });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

// submitUserHrProfile
router.post('/submitUserHrProfile', async (req, res) => {
  try {
    const openid = ''; // 历史列不再写入微信身份；本人由统一账号与成员关系确定。
    const values = req.body.values && typeof req.body.values === 'object' ? req.body.values : {};
    const subject = await resolveSelfHrProfileSubject(req);
    if (subject.status !== 'success') return res.json(subject);
    const { hr, personId, organizationId: orgId } = subject;

    const template = await profileTemplateModel.getByTemplateKey(TEMPLATE_KEY);
    if (!template) return res.json({ status: 'missing_template', message: localeCopy.copy_8e41ad7690 });

    const editMode = template.edit_mode || 'direct';
    if (editMode === 'readonly') return res.json({ status: 'readonly', message: localeCopy.copy_a3d05cdf3f });

    const fields = template.id ? await profileFieldModel.getByTemplateId(template.id) : [];
    const normalizedFields = fields.map((f) => ({
      id: f.id, label: f.label, type: f.type, required: !!f.required,
      minLength: f.min_length, maxLength: f.max_length,
      numberRule: f.number_rule, allowDecimal: !!f.allow_decimal,
      minDigits: f.min_digits, maxDigits: f.max_digits,
      minValue: f.min_value, maxValue: f.max_value,
      options: f.options_json ? JSON.parse(f.options_json) : []
    }));

    const normalizedValues = {};
    const activeFieldIds = normalizedFields.map((field) => field.id);
    for (const field of normalizedFields) {
      const rawValue = values[field.id];
      const err = validateFieldValue(field, rawValue);
      if (err) return res.json({ status: 'invalid_params', message: err });
      normalizedValues[field.id] = rawValue == null ? '' : String(rawValue).trim();
      if (field.type === 'date' && normalizedValues[field.id]) {
        const parsed = tryParseDate(normalizedValues[field.id]);
        if (parsed) normalizedValues[field.id] = parsed;
      }
    }

    const nowUtc = nowMysqlUtc();
    await pool.withTransaction(async (connection) => {
      await unifiedIdentityModel.lockActiveBusinessSubjects(connection, [{
        personId,
        legacyHrId: hr.id,
        organizationId: orgId
      }]);
      const existing = await profileRecordModel.getByHrId(hr.id, connection, orgId);
      const recordId = existing ? existing.id : generateId();
      if (existing) {
        await profileRecordModel.update(existing.id, {
          template_snapshot_id: template.id,
          audit_status: editMode === 'audit' ? 'pending' : 'approved',
          rejection_reason: '',
          requested_at: editMode === 'audit' ? nowUtc : existing.requested_at,
          reviewed_at: editMode === 'audit' ? existing.reviewed_at : nowUtc,
          updated_at: nowUtc
        }, connection, orgId);
      } else {
        await profileRecordModel.create(recordId, {
          hrId: hr.id,
          name: hr.name || '',
          openid,
          templateSnapshotId: template.id,
          auditStatus: editMode === 'audit' ? 'pending' : 'approved',
          requestedAt: editMode === 'audit' ? nowUtc : null,
          reviewedAt: editMode === 'audit' ? null : nowUtc
        }, connection, orgId);
      }
      const targetPending = editMode === 'audit' ? 1 : 0;
      await profileValueModel.removeByRecordIdAndPendingFields(
        recordId, targetPending, activeFieldIds, connection, orgId
      );
      if (editMode !== 'audit') {
        await profileValueModel.removeByRecordIdAndPendingFields(
          recordId, 1, activeFieldIds, connection, orgId
        );
      }
      for (const [fieldId, fieldValue] of Object.entries(normalizedValues)) {
        await profileValueModel.create(
          generateId(), recordId, targetPending, fieldId, fieldValue, connection, orgId
        );
      }
      if (editMode !== 'audit') {
        await personProfileValueModel.upsertEffectiveValues(
          personId, orgId, recordId, normalizedFields, normalizedValues, nowUtc, connection
        );
      }
    });

    res.json({
      status: 'success',
      mode: editMode,
      message: editMode === 'audit' ? personnelCopy.profileSubmitted : personnelCopy.profileSaved
    });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

// 共享模板库与当前组织快照
router.post('/listHrProfileTemplates', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.manage', 'hr.profile_templates.select']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_6e88bbec97 });
    const [list, activeSnapshot] = await Promise.all([
      templateLibrary.listTemplates(), templateLibrary.getActiveSnapshot(context.orgId)
    ]);
    return res.json({
      status: 'success', list, activeSnapshot,
      canManage: hasAnyPermission(context.effective, ['hr.profile_templates.manage']),
      canSelect: hasAnyPermission(context.effective, ['hr.profile_templates.select'])
    });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

router.post('/saveHrProfileTemplateDefinition', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.manage']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_6e88bbec97 });
    return res.json(await templateLibrary.saveDefinition(req.body || {}, context.admin));
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

router.post('/duplicateHrProfileTemplateDefinition', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.manage']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_6e88bbec97 });
    return res.json(await templateLibrary.duplicateDefinition(safeString(req.body.id), context.admin));
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

router.post('/deleteHrProfileTemplateDefinition', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.manage']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_6e88bbec97 });
    return res.json(await templateLibrary.deleteDefinition(safeString(req.body.id)));
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

router.post('/getHrProfileTemplateSwitchContext', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.select']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_04b27bdf7e });
    const result = await templateLibrary.getSwitchContext(context.orgId, safeString(req.body.targetTemplateId));
    return res.json(result ? { status: 'success', ...result } : { status: 'not_found', message: localeCopy.copy_53d06945ab });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

router.post('/previewHrProfileTemplateSwitch', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.select']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_04b27bdf7e });
    return res.json(await templateLibrary.preflightSwitch(
      context.orgId, safeString(req.body.targetTemplateId), req.body.fieldActions
    ));
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

router.post('/applyHrProfileTemplateSwitch', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.select']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_04b27bdf7e });
    return res.json(await templateLibrary.applySwitch(
      context.orgId, safeString(req.body.targetTemplateId), req.body.fieldActions,
      safeString(req.body.switchToken), req.body.confirmDelete === true, context.admin
    ));
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

router.post('/saveOrgHrProfileTemplateSettings', async (req, res) => {
  try {
    const context = await ensureTemplatePermission(req, ['hr.profile_templates.select']);
    if (!context) return res.json({ status: 'forbidden', message: localeCopy.copy_04b27bdf7e });
    return res.json(await templateLibrary.saveOrgSettings(
      context.orgId, safeString(req.body.description), safeString(req.body.editMode || 'direct'), context.admin
    ));
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

// 旧快照写接口已被模板定义接口替代，必须明确退役，禁止返回可误判的业务状态。
router.post('/saveHrProfileTemplate', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// listHrProfileAdminData
router.post('/listHrProfileAdminData', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const orgId = await getCurrentOrgId();
    const [template, hrRows, records] = await Promise.all([
      profileTemplateModel.getByTemplateKey(TEMPLATE_KEY),
      hrInfoModel.getMembershipDirectory(),
      profileRecordModel.getAll()
    ]);

    const [bindingStates, assignmentSummaries] = await Promise.all([
      resolveHrBindingStates(hrRows, orgId),
      unifiedIdentityModel.listDirectoryAssignmentSummaries(hrRows.map((row) => row.id), orgId)
    ]);

    const recordMap = new Map(records.map((r) => [safeString(r.hr_id), r]));

    const recordIds = records.map(r => r.id).filter(Boolean);
    const [allCurrentValues, allPendingValues] = await Promise.all([
      recordIds.length ? profileValueModel.getByRecordIdsAndPending(recordIds, 0) : [],
      recordIds.length ? profileValueModel.getByRecordIdsAndPending(recordIds, 1) : []
    ]);

    const currentValuesByRecord = new Map();
    allCurrentValues.forEach(v => {
      if (!currentValuesByRecord.has(v.record_id)) currentValuesByRecord.set(v.record_id, {});
      currentValuesByRecord.get(v.record_id)[v.field_id] = v.field_value;
    });
    const pendingValuesByRecord = new Map();
    allPendingValues.forEach(v => {
      if (!pendingValuesByRecord.has(v.record_id)) pendingValuesByRecord.set(v.record_id, {});
      pendingValuesByRecord.get(v.record_id)[v.field_id] = v.field_value;
    });

    const legacyHrIds = hrRows.map((row) => safeString(row.id)).filter(Boolean);
    const personByHrId = new Map();
    let sharedValuesByPerson = new Map();
    if (legacyHrIds.length) {
      const hrPlaceholders = legacyHrIds.map(() => '?').join(',');
      const [personRows] = await pool.query(
        `SELECT legacy_hr_id, person_id FROM organization_memberships
          WHERE legacy_hr_id IN (${hrPlaceholders}) AND org_id = ? AND status IN ('active', 'left')`,
        legacyHrIds.concat([orgId])
      );
      personRows.forEach((item) => personByHrId.set(safeString(item.legacy_hr_id), safeString(item.person_id)));
      const personIds = personRows.map((item) => safeString(item.person_id)).filter(Boolean);
      const sharedRows = await personProfileValueModel.listForPersons(personIds);
      sharedRows.forEach((item) => {
        const byPerson = sharedValuesByPerson.get(safeString(item.person_id)) || {};
        byPerson[personProfileValueModel.key(item.normalized_label || item.field_label, item.field_type)] = item;
        sharedValuesByPerson.set(safeString(item.person_id), byPerson);
      });
    }

    const fields = template && template.id ? await profileFieldModel.getByTemplateId(template.id) : [];
    const fieldObjs = fields.map((f) => ({
      id: f.id, label: f.label, type: f.type, required: !!f.required,
      options: f.options_json ? JSON.parse(f.options_json) : []
    }));
    const activeFieldIds = new Set(fieldObjs.map((field) => field.id));

    const summarizeValues = (valsMap) => fieldObjs
      .map((f) => { const v = valsMap[f.id]; return v ? `${f.label}：${v}` : ''; })
      .filter(Boolean).join('；');

    const rows = [];
    for (const item of hrRows) {
      const record = recordMap.get(item.id);
      const currentRaw = record ? (currentValuesByRecord.get(record.id) || {}) : {};
      const pendingRaw = record ? (pendingValuesByRecord.get(record.id) || {}) : {};
      const currentValues = Object.keys(currentRaw).reduce((result, fieldId) => {
        if (activeFieldIds.has(fieldId)) result[fieldId] = currentRaw[fieldId];
        return result;
      }, {});
      const sharedValues = sharedValuesByPerson.get(personByHrId.get(safeString(item.id))) || {};
      fieldObjs.forEach((field) => {
        const shared = sharedValues[personProfileValueModel.key(field.label, field.type)];
        if (shared) currentValues[field.id] = shared.field_value == null ? '' : String(shared.field_value);
      });
      const pendingValues = Object.keys(pendingRaw).reduce((result, fieldId) => {
        if (activeFieldIds.has(fieldId)) result[fieldId] = pendingRaw[fieldId];
        return result;
      }, {});
      const auditStatus = safeString(record ? record.audit_status || 'none' : 'none') || 'none';
      const completeness = profileCompleteness(fieldObjs, currentValues, pendingValues, auditStatus);

      const binding = bindingStates.get(safeString(item.id)) || {
        status: 'unbound',
        userInfoId: '',
        boundOpenid: ''
      };
      const assignmentSummary = assignmentSummaries.get(safeString(item.id)) || {
        count: 0,
        departments: [],
        identities: [],
        workGroups: [],
        assignmentNatures: [],
        assignments: []
      };
      rows.push({
        id: item.id,
        personId: safeString(item.person_id),
        membershipId: safeString(item.membership_id),
        membershipStatus: safeString(item.membership_status) || 'active',
        joinedAt: item.joined_at || null,
        leftAt: item.left_at || null,
        recordId: safeString(record ? record.id : ''),
        name: safeString(item.name),
        studentId: safeString(item.student_id),
        assignmentCount: assignmentSummary.count,
        assignments: assignmentSummary.assignments,
        assignmentNatures: assignmentSummary.assignmentNatures,
        departments: assignmentSummary.departments,
        identities: assignmentSummary.identities,
        workGroups: assignmentSummary.workGroups,
        department: assignmentSummary.departments.join('、'),
        identity: assignmentSummary.identities.join('、'),
        workGroup: assignmentSummary.workGroups.join('、'),
        currentSummary: summarizeValues(currentValues) || localeCopy.copy_4049b5c6cd,
        pendingSummary: summarizeValues(pendingValues),
        currentValues,
        pendingValues,
        auditStatus,
        auditStatusText: PROFILE_STATUS_TEXT[auditStatus] || localeCopy.copy_67f2697101,
        isComplete: completeness.isComplete,
        missingRequiredFieldIds: completeness.missingRequiredFieldIds,
        rejectionReason: safeString(record ? record.rejection_reason : ''),
        hasPending: auditStatus === 'pending' && Object.keys(pendingValues).length > 0,
        userInfoId: binding.userInfoId,
        boundOpenid: binding.boundOpenid ? safeString(binding.boundOpenid).slice(0, 8) + '***' : '',
        wxBindStatus: binding.status
      });
    }
    res.json({
      status: 'success',
      template: template ? {
        description: template.description || '',
        editMode: template.edit_mode || 'direct',
        modeText: MODE_TEXT_MAP[template.edit_mode || 'direct'] || MODE_TEXT_MAP.direct,
        fields: fields.map((f) => ({
          id: f.id, label: f.label, type: f.type, required: !!f.required,
          minLength: f.min_length, maxLength: f.max_length,
          numberRule: f.number_rule, allowDecimal: !!f.allow_decimal,
          minDigits: f.min_digits, maxDigits: f.max_digits,
          minValue: f.min_value, maxValue: f.max_value,
          options: f.options_json ? JSON.parse(f.options_json) : []
        }))
      } : null,
      rows,
      capabilities: {
        canManagePeople: hasAnyPermission(req.adminPermissions, ['hr.people']),
        canReviewProfiles: hasAnyPermission(req.adminPermissions, ['hr.profile_review']),
        canGlobalAccountManage: hasAnyPermission(req.adminPermissions, ['auth.accounts.global_manage'])
      }
    });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

// reviewHrProfileChange
router.post('/reviewHrProfileChange', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const hrId = safeString(req.body.hrId);
    const studentId = safeString(req.body.studentId);
    const action = safeString(req.body.action);
    const reason = safeString(req.body.reason);

    if ((!hrId && !studentId) || ['approve', 'reject'].indexOf(action) === -1) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_2941385e2b });
    }
    if (action === 'reject' && !reason) {
      return res.json({ status: 'invalid_params', message: personnelCopy.rejectReasonRequired });
    }

    const hrRecord = hrId
      ? await hrInfoModel.getById(hrId)
      : await hrInfoModel.getByStudentId(studentId);
    if (!hrRecord) return res.json({ status: 'not_found', message: localeCopy.copy_8709282967 });

    const orgId = await getCurrentOrgId();
    const nowUtc = nowMysqlUtc();
    const reviewResult = await pool.withTransaction(async (connection) => {
      await unifiedIdentityModel.lockActiveBusinessSubjects(connection, [{
        legacyHrId: hrRecord.id,
        organizationId: orgId
      }]);
      const record = await profileRecordModel.getByHrId(hrRecord.id, connection, orgId, true);
      if (!record) return { status: 'not_found' };
      const effectiveVals = await profileValueModel.getByRecordIdAndPending(
        record.id, 0, connection, orgId, true
      );
      const pendingVals = await profileValueModel.getByRecordIdAndPending(
        record.id, 1, connection, orgId, true
      );
      if (!pendingVals.length || safeString(record.audit_status) !== 'pending') {
        return { status: 'invalid_operation' };
      }
      const pendingFieldIds = Array.from(new Set(pendingVals.map((value) => value.field_id)));
      const submittedFields = await profileFieldModel.getByIds(pendingFieldIds, orgId, connection);
      if (submittedFields.length !== pendingFieldIds.length) return { status: 'invalid_operation' };
      const effectiveSnapshot = {};
      const pendingSnapshot = {};
      effectiveVals.forEach((value) => { effectiveSnapshot[value.field_id] = value.field_value; });
      pendingVals.forEach((value) => { pendingSnapshot[value.field_id] = value.field_value; });
      if (action === 'approve') {
        await profileValueModel.removeByRecordIdAndPendingFields(
          record.id, 0, pendingFieldIds, connection, orgId
        );
        for (const value of pendingVals) {
          await profileValueModel.create(
            generateId(), record.id, 0, value.field_id, value.field_value, connection, orgId
          );
        }
        await profileValueModel.removeByRecordIdAndPendingFields(
          record.id, 1, pendingFieldIds, connection, orgId
        );
        await profileRecordModel.update(record.id, {
          audit_status: 'approved', rejection_reason: '', reviewed_at: nowUtc, updated_at: nowUtc
        }, connection, orgId);
        const person = await personIdentityOverviewModel.resolvePersonByLegacyHrId(hrRecord.id, connection);
        if (person) {
          await personProfileValueModel.upsertEffectiveValues(
            person.id, orgId, record.id,
            submittedFields.map((field) => ({ id: field.id, label: field.label, type: field.type })),
            pendingSnapshot, nowUtc, connection
          );
        }
      } else {
        await profileValueModel.removeByRecordIdAndPendingFields(
          record.id, 1, pendingFieldIds, connection, orgId
        );
        await profileRecordModel.update(record.id, {
          audit_status: 'rejected', rejection_reason: reason, reviewed_at: nowUtc, updated_at: nowUtc
        }, connection, orgId);
      }
      await profileReviewEventModel.create({
        recordId: record.id,
        action,
        reason,
        reviewerPersonId: req.authAccount && req.authAccount.personId,
        reviewerContextId: req.authContext && req.authContext.contextId,
        effectiveValues: effectiveSnapshot,
        pendingValues: pendingSnapshot,
        organizationId: orgId
      }, connection);
      return { status: 'success', recordId: record.id };
    });

    if (reviewResult.status === 'not_found') {
      return res.json({ status: 'not_found', message: localeCopy.copy_8709282967 });
    }
    if (reviewResult.status === 'invalid_operation') {
      return res.json({ status: 'invalid_operation', message: localeCopy.copy_0095182bd4 });
    }

    try {
      await createNotification({
        hrId: hrRecord.id,
        eventKey: 'hr-profile-review:' + reviewResult.recordId + ':' + nowUtc,
        type: action === 'approve' ? 'hr_profile_approved' : 'hr_profile_rejected',
        title: action === 'approve' ? personnelCopy.profileApproved : personnelCopy.profileRejected,
        description: action === 'approve'
          ? personnelCopy.profileApprovedNotice
          : localeFormat(personnelCopy.profileRejectedNotice, [reason]),
        category: 'hr',
        targetType: 'hr_profile',
        targetId: hrRecord.id,
        targetUrl: '/subpackages/workspace/pages/home/home?subApp=hr'
      });
    } catch (notificationError) {
      req.logger.error('HR profile review notification failed', {
        error: safeString(notificationError.message),
        recordId: reviewResult.recordId
      });
    }

    res.json({ status: 'success' });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

// getHrPersonDetail
router.post('/getHrPersonDetail', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const hrId = safeString(req.body.hrId);
    if (!hrId) return res.json({ status: 'invalid_params', message: localeCopy.copy_eb00430bd4 });

    const hr = await hrInfoModel.getByIdIncludingFormer(hrId);
    if (!hr) return res.json({ status: 'not_found', message: localeCopy.copy_9ccefa96da });
    const orgId = await getCurrentOrgId();

    const template = await profileTemplateModel.getByTemplateKey(TEMPLATE_KEY);
    const templateData = template ? {
      description: template.description || '',
      editMode: template.edit_mode || 'direct',
      modeText: MODE_TEXT_MAP[template.edit_mode || 'direct'] || MODE_TEXT_MAP.direct,
      fields: template.id
        ? (await profileFieldModel.getByTemplateId(template.id)).map((f) => ({
            id: f.id, label: f.label, type: f.type, required: !!f.required,
            minLength: f.min_length, maxLength: f.max_length,
            numberRule: f.number_rule, allowDecimal: !!f.allow_decimal,
            minDigits: f.min_digits, maxDigits: f.max_digits,
            minValue: f.min_value, maxValue: f.max_value,
            options: f.options_json ? JSON.parse(f.options_json) : []
          }))
        : []
    } : null;

    const record = await profileRecordModel.getByHrId(hrId);
    const activeFieldIds = new Set(templateData ? templateData.fields.map((field) => field.id) : []);
    let values = {};
    let pendingValues = {};
    let historicalFields = [];
    const reviewHistory = record
      ? await profileReviewEventModel.listByRecordId(record.id, orgId)
      : [];
    if (record) {
      const [vals, pvals] = await Promise.all([
        profileValueModel.getByRecordIdAndPending(record.id, 0, pool, orgId),
        profileValueModel.getByRecordIdAndPending(record.id, 1, pool, orgId)
      ]);
      const historicalValues = {};
      const historicalPendingValues = {};
      vals.forEach((value) => {
        if (activeFieldIds.has(value.field_id)) values[value.field_id] = value.field_value;
        else historicalValues[value.field_id] = value.field_value;
      });
      pvals.forEach((value) => {
        if (activeFieldIds.has(value.field_id)) pendingValues[value.field_id] = value.field_value;
        else historicalPendingValues[value.field_id] = value.field_value;
      });
      reviewHistory.forEach((event) => {
        const effectiveSnapshot = parseJsonObject(event.effective_values_snapshot);
        const pendingSnapshot = parseJsonObject(event.pending_values_snapshot);
        Object.keys(effectiveSnapshot).forEach((fieldId) => {
          if (!activeFieldIds.has(fieldId) && !Object.prototype.hasOwnProperty.call(historicalValues, fieldId)) {
            historicalValues[fieldId] = effectiveSnapshot[fieldId];
          }
        });
        Object.keys(pendingSnapshot).forEach((fieldId) => {
          if (!activeFieldIds.has(fieldId) && !Object.prototype.hasOwnProperty.call(historicalPendingValues, fieldId)) {
            historicalPendingValues[fieldId] = pendingSnapshot[fieldId];
          }
        });
      });
      const historicalFieldIds = Array.from(new Set(
        Object.keys(historicalValues).concat(Object.keys(historicalPendingValues))
      ));
      const historicalDefinitions = await profileFieldModel.getByIds(historicalFieldIds, orgId);
      historicalFields = historicalDefinitions
        .filter((field) => !activeFieldIds.has(safeString(field.id)))
        .map((field) => Object.assign(profileFieldResponse(field, true), {
          value: Object.prototype.hasOwnProperty.call(historicalValues, field.id)
            ? safeString(historicalValues[field.id]) : '',
          pendingValue: Object.prototype.hasOwnProperty.call(historicalPendingValues, field.id)
            ? safeString(historicalPendingValues[field.id]) : ''
        }));
    }

    const person = await personIdentityOverviewModel.resolvePersonByLegacyHrId(hrId, null, true);
    if (person && templateData && templateData.fields.length) {
      const globalRows = await personProfileValueModel.listForPerson(person.id);
      const globalValues = personProfileValueModel.mapRows(globalRows);
      templateData.fields.forEach((field) => {
        const shared = globalValues[personProfileValueModel.key(field.label, field.type)];
        if (shared) values[field.id] = shared.field_value == null ? '' : String(shared.field_value);
      });
    }

    const auditStatus = record ? (record.audit_status || 'none') : 'none';
    const rejectionReason = record ? (record.rejection_reason || '') : '';
    const completeness = profileCompleteness(
      templateData ? templateData.fields : [], values, pendingValues, auditStatus
    );

    res.json({
      status: 'success',
      profile: await enrichHrWithOrg(hr),
      template: templateData,
      values,
      pendingValues,
      historicalFields,
      auditStatus,
      auditStatusText: PROFILE_STATUS_TEXT[auditStatus] || localeCopy.copy_67f2697101,
      isComplete: completeness.isComplete,
      missingRequiredFieldIds: completeness.missingRequiredFieldIds,
      rejectionReason,
      hasPending: auditStatus === 'pending' && Object.keys(pendingValues).length > 0,
      reviewHistory: reviewHistory.map((item) => ({
        id: safeString(item.id),
        action: safeString(item.action),
        reason: safeString(item.reason),
        reviewerName: safeString(item.reviewer_name),
        reviewerPersonId: safeString(item.reviewer_person_id),
        reviewerContextId: safeString(item.reviewer_context_id),
        createdAt: item.created_at
      })),
      membershipStatus: safeString(hr.membership_status) || 'active',
      joinedAt: hr.joined_at || null,
      leftAt: hr.left_at || null
    });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

// saveHrPersonFull
router.post('/saveHrPersonFull', async (req, res) => {
  try {
    const openid = ''; // 管理操作同样不以微信标识记录本人。
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const hrId = safeString(req.body.hrId);
    const name = safeString(req.body.name);
    const studentId = safeString(req.body.studentId);
    const profileValues = req.body.profileValues && typeof req.body.profileValues === 'object' ? req.body.profileValues : {};

    if (!name || !studentId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_2ffe8c71d9 });
    }
    if (!hrId) return res.json({ status: 'invalid_params', message: localeCopy.copy_eb00430bd4 });

    const hr = await hrInfoModel.getById(hrId);
    if (!hr) return res.json({ status: 'not_found', message: localeCopy.copy_9ccefa96da });
    const canManagePeople = Boolean(req.adminPermissions && (
      (req.adminPermissions.permissions && req.adminPermissions.permissions['hr.people'])
      || req.adminPermissions['hr.people']
    ));
    if (!canManagePeople) {
      return res.json({ status: 'permission_denied', message: localeCopy.copy_b0fe1df7fb });
    }

    const now = nowMysqlUtc();
    if (name !== safeString(hr.name) || studentId !== safeString(hr.student_id)) {
      return res.json({
        status: 'person_correction_required',
        message: personnelCopy.personCorrectionRequired
      });
    }

    if (Object.keys(profileValues).length > 0) {
      const template = await profileTemplateModel.getByTemplateKey(TEMPLATE_KEY);
      if (!template) return res.json({ status: 'missing_template', message: localeCopy.copy_8e41ad7690 });

      const fields = template.id ? await profileFieldModel.getByTemplateId(template.id) : [];
      const normalizedFields = fields.map((f) => ({
        id: f.id, label: f.label, type: f.type, required: !!f.required,
        minLength: f.min_length, maxLength: f.max_length,
        numberRule: f.number_rule, allowDecimal: !!f.allow_decimal,
        minDigits: f.min_digits, maxDigits: f.max_digits,
        minValue: f.min_value, maxValue: f.max_value,
        options: f.options_json ? JSON.parse(f.options_json) : []
      }));

      const fieldMap = new Map(normalizedFields.map((f) => [f.id, f]));
      const normalizedValues = {};
      for (const [fieldId, rawValue] of Object.entries(profileValues)) {
        const field = fieldMap.get(fieldId);
        if (!field) continue;
        const err = validateFieldValue(field, rawValue, true);
        if (err) return res.json({ status: 'invalid_params', message: err });
        normalizedValues[fieldId] = rawValue == null ? '' : String(rawValue).trim();
        if (field.type === 'date' && normalizedValues[fieldId]) {
          const parsed = tryParseDate(normalizedValues[fieldId]);
          if (parsed) normalizedValues[fieldId] = parsed;
        }
      }

      const orgId = await getCurrentOrgId();
      await pool.withTransaction(async (connection) => {
        await unifiedIdentityModel.lockActiveBusinessSubjects(connection, [{
          legacyHrId: hrId,
          organizationId: orgId
        }]);
        const existing = await profileRecordModel.getByHrId(hrId, connection, orgId, true);
        const recordId = existing ? existing.id : generateId();
        const pendingRows = existing
          ? await profileValueModel.getByRecordIdAndPending(existing.id, 1, connection, orgId, true)
          : [];
        const pendingSnapshot = {};
        pendingRows.forEach((row) => {
          if (fieldMap.has(row.field_id)) pendingSnapshot[row.field_id] = row.field_value;
        });
        const preservePending = Boolean(
          existing
          && safeString(existing.audit_status) === 'pending'
          && Object.keys(pendingSnapshot).length
        );
        if (existing) {
          await profileValueModel.removeByRecordIdAndPendingFields(
            existing.id, 0, normalizedFields.map((field) => field.id), connection, orgId
          );
          await profileRecordModel.update(existing.id, {
            templateSnapshotId: template.id,
            auditStatus: preservePending ? 'pending' : 'approved',
            rejectionReason: preservePending ? safeString(existing.rejection_reason) : '',
            reviewedAt: preservePending ? existing.reviewed_at : now,
            updatedAt: now
          }, connection, orgId);
        } else {
          await profileRecordModel.create(recordId, {
            hrId, name, openid, templateSnapshotId: template.id,
            auditStatus: 'approved', reviewedAt: now
          }, connection, orgId);
        }
        for (const [fieldId, fieldValue] of Object.entries(normalizedValues)) {
          await profileValueModel.create(generateId(), recordId, 0, fieldId, fieldValue, connection, orgId);
        }
        const person = await personIdentityOverviewModel.resolvePersonByLegacyHrId(hrId, connection);
        if (person) {
          await personProfileValueModel.upsertEffectiveValues(
            person.id, orgId, recordId, normalizedFields, normalizedValues, now, connection
          );
        }
        await profileReviewEventModel.create({
          recordId,
          action: 'maintained',
          reviewerPersonId: req.authAccount && req.authAccount.personId,
          reviewerContextId: req.authContext && req.authContext.contextId,
          effectiveValues: normalizedValues,
          pendingValues: pendingSnapshot,
          organizationId: orgId
        }, connection);
      });
    }

    res.json({ status: 'success', message: localeCopy.copy_3c00278e45 });
  } catch (e) {
    return sendHrProfileFailure(req, res, e);
  }
});

module.exports = router;
