const localeCopy = require('../../../../../locales/zh-CN/generated/subpackages/scoring/pages/admin/modules/adminUtils');
const { format: localeFormat } = require('../../../../../locales/runtime');
// Auto-extracted pure utilities and constants from admin.js
// These functions have NO Page 'this' context — they are pure data transforms.
// All constants and factories used by admin.js and behaviors are here.

const TAB_LIST = ['activities', 'templates', 'rules', 'results', 'hrInfo', 'hrTemplates', 'departments', 'workGroups', 'identities', 'admins', 'settings', 'publications', 'auditTemplates', 'auditStamps', 'auditSubmissions', 'auditVerification'];
const TIMEZONE_OPTIONS = [
  { value: -12, label: localeCopy.copy_f9cadda36d },
  { value: -11, label: localeCopy.copy_4570b42d70 },
  { value: -10, label: localeCopy.copy_757124dc6b },
  { value: -9, label: localeCopy.copy_7cd25c7e87 },
  { value: -8, label: localeCopy.copy_55c5b5ff7b },
  { value: -7, label: localeCopy.copy_ec688c2a7c },
  { value: -6, label: localeCopy.copy_a0e4ae632c },
  { value: -5, label: localeCopy.copy_4462cb7b00 },
  { value: -4, label: localeCopy.copy_72c79414ae },
  { value: -3, label: localeCopy.copy_cf2edf4e91 },
  { value: -2, label: localeCopy.copy_657e432e78 },
  { value: -1, label: localeCopy.copy_2952640fa0 },
  { value: 0, label: localeCopy.copy_609094214c },
  { value: 1, label: localeCopy.copy_d13ebf61e8 },
  { value: 2, label: localeCopy.copy_2f4c345a3b },
  { value: 3, label: localeCopy.copy_ab805e8327 },
  { value: 4, label: localeCopy.copy_484de22700 },
  { value: 5, label: localeCopy.copy_b0e703c2d3 },
  { value: 6, label: localeCopy.copy_467bc10285 },
  { value: 7, label: localeCopy.copy_e2418cf46c },
  { value: 8, label: localeCopy.copy_05746fc036 },
  { value: 9, label: localeCopy.copy_5f0a93e6d5 },
  { value: 10, label: localeCopy.copy_9d0e9da601 },
  { value: 11, label: localeCopy.copy_04e6a36058 },
  { value: 12, label: localeCopy.copy_570fa0981d }
];
const RULE_SCOPE_OPTIONS = [
  { value: 'same_department_identity', label: localeCopy.copy_e315078ee8 },
  { value: 'same_department_all', label: localeCopy.copy_2603ee59e5 },
  { value: 'same_work_group_identity', label: localeCopy.copy_f9444318ff },
  { value: 'same_work_group_all', label: localeCopy.copy_12771a58c9 },
  { value: 'identity_only', label: localeCopy.copy_22676ecf45 },
  { value: 'all_people', label: localeCopy.copy_76d431a4dc }
];
const VIEW_SCOPE_OPTIONS = [
  { value: 'own_results', label: localeCopy.copy_9a4a6e8793 },
  { value: 'same_work_group_identity', label: localeCopy.copy_3787c80077 },
  { value: 'same_work_group_all', label: localeCopy.copy_fd80cc149b },
  { value: 'same_department_identity', label: localeCopy.copy_c70c40dae1 },
  { value: 'same_department_all', label: localeCopy.copy_8e7c345003 },
  { value: 'all_people', label: localeCopy.copy_1580e09c5c }
];
const VIEW_SCOPE_LABEL_MAP = VIEW_SCOPE_OPTIONS.reduce((map, item) => { map[item.value] = item.label; return map; }, {});
const PROFILE_EDIT_MODE_OPTIONS = [
  { value: 'direct', label: localeCopy.copy_bc64256f91 },
  { value: 'audit', label: localeCopy.copy_424e9fe3b4 },
  { value: 'readonly', label: localeCopy.copy_a1399ed0a2 }
];
const PROFILE_FIELD_TYPE_OPTIONS = [
  { value: 'text', label: localeCopy.copy_12e5c96d1e },
  { value: 'number', label: localeCopy.copy_dfb6c2130f },
  { value: 'sequence', label: localeCopy.copy_f942ac6f2a },
  { value: 'date', label: localeCopy.copy_45d46b9df2 },
  { value: 'phone', label: localeCopy.copy_8e0c2b3066 },
  { value: 'email', label: localeCopy.copy_138db9568c }
];
const NUMBER_RULE_OPTIONS = [
  { value: 'value_range', label: localeCopy.copy_4588759d51 },
  { value: 'length_range', label: localeCopy.copy_97fbcb1897 }
];

const RULE_SCOPE_LABEL_MAP = RULE_SCOPE_OPTIONS.reduce((map, item) => {
  map[item.value] = item.label;
  return map;
}, {});

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const TEMPLATE_CSV_FIELDS = [
  { key: 'question',   label: localeCopy.copy_1af596e2ba, aliases: [localeCopy.copy_12fc5f1a33, localeCopy.copy_1af596e2ba, localeCopy.copy_b66cf0dd1d, 'question'] },
  { key: 'scoreLabel', label: localeCopy.copy_fd0da10351, aliases: [localeCopy.copy_fd0da10351, localeCopy.copy_28d0daa28f, 'scoreLabel', localeCopy.copy_1702a69e64, localeCopy.copy_10b1158748] },
  { key: 'minValue',   label: localeCopy.copy_e24b33ba5f,   aliases: [localeCopy.copy_e24b33ba5f, localeCopy.copy_c741409c82, 'minValue', 'min', localeCopy.copy_9a2cca25f2] },
  { key: 'startValue', label: localeCopy.copy_4366ed3bb6,   aliases: [localeCopy.copy_4366ed3bb6, localeCopy.copy_ce2a519308, 'startValue', 'start', localeCopy.copy_62f0d4f3c1] },
  { key: 'maxValue',   label: localeCopy.copy_8ca6566932,   aliases: [localeCopy.copy_8ca6566932, localeCopy.copy_fb031f3568, 'maxValue', 'max', localeCopy.copy_103f952a56] },
  { key: 'stepValue',  label: localeCopy.copy_4b62966880,   aliases: [localeCopy.copy_4b62966880, localeCopy.copy_8c44208d45, 'stepValue', 'step', localeCopy.copy_13d5166c86] }
];

function _csvEscapeField(value) {
  const s = String(value == null ? '' : value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatScoreFixed3(value) {
  return toNumber(value, 0).toFixed(3);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ── Progress bar colour: 0–100 HSL lookup (red → orange → yellow → green, always bright) ──
function getProgressColor(ratePercent) {
  const t = clampNumber(toNumber(ratePercent, 0), 0, 100) / 100;

  // Hue: 0° red → 30° orange → 55° golden-yellow → 140° green
  let hue;
  if (t < 0.35)       hue = (t / 0.35) * 30;               // 0–35%  red → orange
  else if (t < 0.65)  hue = 30 + ((t - 0.35) / 0.30) * 25; // 35–65% orange → yellow
  else                hue = 55 + ((t - 0.65) / 0.35) * 85;  // 65–100% yellow → green

  // Saturation: high throughout (80–95%), peaking in the middle
  const sat = 85 + Math.sin(t * Math.PI) * 10;

  // Lightness: bright range (48–58%), peaking at golden-yellow
  const light = 50 + Math.sin(t * Math.PI) * 8;

  return `hsl(${Math.round(hue)}, ${Math.round(sat)}%, ${Math.round(light)}%)`;
}

function buildProgressFillStyle(ratePercent) {
  const percent = clampNumber(toNumber(ratePercent, 0), 0, 100);
  const color = getProgressColor(percent);
  return `width: ${percent}%; background: linear-gradient(90deg, rgba(255,255,255,0.30), ${color});`;
}

function emptyRuleForm() {
  return {
    id: '',
    scorerDepartmentId: '',
    scorerDepartment: '',
    scorerIdentityId: '',
    scorerIdentity: '',
    allowSelfAssessment: true,
    clauseScope: RULE_SCOPE_OPTIONS[0].value,
    clauseScopeLabel: RULE_SCOPE_OPTIONS[0].label,
    clauseTargetIdentityId: '',
    clauseTargetIdentity: '',
    clauseRequireAllComplete: false,
    clauseTemplateId: '',
    clauseTemplateName: '',
    clauseTemplateWeight: '1',
    clauseTemplateOrder: '',
    clauseCalculationMethod: 'weighted_average',
    clauseTrimHighCount: 0,
    clauseTrimLowCount: 0,
    clauseTemplateConfigEditingIndex: -1,
    clauseEditingIndex: -1,
    isRuleClauseEditorVisible: false,
    isTemplateConfigEditorVisible: false,
    clauseTemplateConfigs: [],
    clauses: []
  };
}

function emptyHrForm() {
  return {
    id: '',
    name: '',
    studentId: '',
    department: '',
    identity: '',
    workGroup: ''
  };
}

function createEmptyProfileField() {
  return {
    id: `profile_field_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    label: '',
    type: PROFILE_FIELD_TYPE_OPTIONS[0].value,
    typeLabel: PROFILE_FIELD_TYPE_OPTIONS[0].label,
    required: false,
    minLength: '',
    maxLength: '',
    numberRule: NUMBER_RULE_OPTIONS[0].value,
    numberRuleLabel: NUMBER_RULE_OPTIONS[0].label,
    allowDecimal: true,
    minDigits: '',
    maxDigits: '',
    minValue: '',
    maxValue: '',
    optionsText: ''
  };
}

function emptyHrProfileTemplateForm() {
  return {
    id: '',
    name: '',
    description: '',
    editMode: PROFILE_EDIT_MODE_OPTIONS[0].value,
    editModeLabel: PROFILE_EDIT_MODE_OPTIONS[0].label,
    fields: [createEmptyProfileField()]
  };
}

function normalizeHrProfileFieldForForm(field = {}) {
  const type = field.type || PROFILE_FIELD_TYPE_OPTIONS[0].value;
  const typeOption = PROFILE_FIELD_TYPE_OPTIONS.find((item) => item.value === type) || PROFILE_FIELD_TYPE_OPTIONS[0];
  const numberRule = field.numberRule || NUMBER_RULE_OPTIONS[0].value;
  const numberRuleOption = NUMBER_RULE_OPTIONS.find((item) => item.value === numberRule) || NUMBER_RULE_OPTIONS[0];
  return {
    id: field.id || createEmptyProfileField().id,
    label: field.label || '',
    type,
    typeLabel: typeOption.label,
    required: field.required === true,
    minLength: field.minLength == null ? '' : String(field.minLength),
    maxLength: field.maxLength == null ? '' : String(field.maxLength),
    numberRule,
    numberRuleLabel: numberRuleOption.label,
    allowDecimal: field.allowDecimal !== false,
    minDigits: field.minDigits == null ? '' : String(field.minDigits),
    maxDigits: field.maxDigits == null ? '' : String(field.maxDigits),
    minValue: field.minValue == null ? '' : String(field.minValue),
    maxValue: field.maxValue == null ? '' : String(field.maxValue),
    optionsText: Array.isArray(field.options) ? field.options.join('\n') : ''
  };
}

function emptyAdminForm() {
  return {
    id: '',
    name: '',
    studentId: '',
    adminLevel: 'admin'
  };
}

function emptyDepartmentForm() {
  return {
    id: '',
    name: '',
    description: ''
  };
}

function emptyWorkGroupForm() {
  return {
    id: '',
    name: '',
    departmentId: '',
    departmentCode: '',
    departmentName: '',
    description: ''
  };
}

function emptyIdentityForm() {
  return {
    id: '',
    name: '',
    description: ''
  };
}

function emptyActivityForm() {
  return {
    id: '',
    name: '',
    description: '',
    startDate: '',
    endDate: '',
    participantGranularity: 'assignment',
    participantGranularityIndex: 0
  };
}

function createEmptyQuestion() {
  return {
    question: '',
    scoreLabel: '',
    minValue: '0',
    startValue: '0',
    maxValue: '10',
    stepValue: '1'
  };
}

function normalizeTemplateQuestionForForm(question = {}) {
  return {
    question: question.question || '',
    scoreLabel: question.scoreLabel || '',
    minValue: String(question.minValue == null ? 0 : question.minValue),
    startValue: String(question.startValue == null ? 0 : question.startValue),
    maxValue: String(question.maxValue == null ? 0 : question.maxValue),
    stepValue: String(question.stepValue == null ? 0.5 : question.stepValue)
  };
}

function emptyTemplateForm() {
  return {
    id: '',
    name: '',
    description: '',
    questions: []
  };
}

function createLocalInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createTemplateConfig(config = {}) {
  return {
    templateId: config.templateId || '',
    templateName: config.templateName || '',
    weight: config.weight == null ? '1' : String(config.weight),
    sortOrder: config.sortOrder == null ? '' : String(config.sortOrder),
    calculationMethod: config.calculationMethod || 'weighted_average',
    trimHighCount: Number(config.trimHighCount || 0),
    trimLowCount: Number(config.trimLowCount || 0)
  };
}

function normalizeClauseForEdit(clause = {}) {
  const templateConfigs = Array.isArray(clause.templateConfigs) && clause.templateConfigs.length
    ? clause.templateConfigs.map((item) => createTemplateConfig(item))
    : [];

  return {
    scopeType: clause.scopeType || RULE_SCOPE_OPTIONS[0].value,
    scopeLabel: getScopeLabel(clause.scopeType || RULE_SCOPE_OPTIONS[0].value),
    targetIdentityId: String(clause.targetIdentityId || '').trim(),
    targetIdentity: String(clause.targetIdentity || '').trim(),
    requireAllComplete: clause.requireAllComplete === true,
    templateConfigs
  };
}

function moveItem(list, fromIndex, toIndex) {
  const nextList = [...list];
  const [moved] = nextList.splice(fromIndex, 1);
  nextList.splice(toIndex, 0, moved);
  return nextList;
}

function refreshTemplateConfigSortOrder(templateConfigs = []) {
  return templateConfigs.map((item, index) => ({
    ...item,
    sortOrder: String(index + 1)
  }));
}

function getScopeLabel(value) {
  return RULE_SCOPE_LABEL_MAP[value] || value || '';
}

function normalizeTemplateConfigsForSave(templateConfigs = []) {
  return refreshTemplateConfigSortOrder((templateConfigs || [])
    .map((item) => ({
      templateId: String(item.templateId || '').trim(),
      templateName: String(item.templateName || '').trim(),
      weight: String(item.weight == null ? '1' : item.weight).trim(),
      sortOrder: String(item.sortOrder || '').trim(),
      calculationMethod: item.calculationMethod || 'weighted_average',
      trimHighCount: Number(item.trimHighCount || 0),
      trimLowCount: Number(item.trimLowCount || 0)
    }))
    .filter((item) => item.templateId));
}

function buildPendingTemplateConfigForSave(form = {}) {
  const templateId = String(form.clauseTemplateId || '').trim();
  if (!templateId) {
    return {
      status: 'empty'
    };
  }

  const weight = Number(form.clauseTemplateWeight);
  if (!Number.isFinite(weight) || weight <= 0) {
    return {
      status: 'invalid',
      message: localeCopy.copy_ba359df757
    };
  }

  const currentConfigs = Array.isArray(form.clauseTemplateConfigs) ? form.clauseTemplateConfigs : [];
  const editingIndex = Number(form.clauseTemplateConfigEditingIndex);
  const sortOrderValue = editingIndex >= 0 && currentConfigs[editingIndex]
    ? Number(currentConfigs[editingIndex].sortOrder) || (editingIndex + 1)
    : currentConfigs.length + 1;

  return {
    status: 'ready',
    config: {
      templateId,
      templateName: String(form.clauseTemplateName || '').trim(),
      weight: String(weight),
      sortOrder: String(sortOrderValue),
      calculationMethod: form.clauseCalculationMethod || 'weighted_average',
      trimHighCount: Number(form.clauseTrimHighCount || 0),
      trimLowCount: Number(form.clauseTrimLowCount || 0)
    }
  };
}

function mergePendingTemplateConfig(form = {}) {
  const templateConfigs = [...(form.clauseTemplateConfigs || [])];
  const pending = buildPendingTemplateConfigForSave(form);
  if (pending.status !== 'ready') {
    return {
      ok: pending.status !== 'invalid',
      message: pending.message || '',
      templateConfigs: normalizeTemplateConfigsForSave(templateConfigs)
    };
  }

  const editingIndex = Number(form.clauseTemplateConfigEditingIndex);
  if (editingIndex >= 0 && templateConfigs[editingIndex]) {
    templateConfigs[editingIndex] = pending.config;
  } else {
    const exists = templateConfigs.some((item) => (
      String(item.templateId || '') === pending.config.templateId
    ));
    if (!exists) {
      templateConfigs.push(pending.config);
    }
  }

  return {
    ok: true,
    message: '',
    templateConfigs: normalizeTemplateConfigsForSave(templateConfigs)
  };
}

function hasPendingRuleClauseDraft(form = {}) {
  return Number(form.clauseEditingIndex) >= 0
    || String(form.clauseTargetIdentityId || '').trim()
    || form.clauseRequireAllComplete === true
    || String(form.clauseTemplateId || '').trim()
    || (Array.isArray(form.clauseTemplateConfigs) && form.clauseTemplateConfigs.length > 0)
    || String(form.clauseScope || RULE_SCOPE_OPTIONS[0].value) !== RULE_SCOPE_OPTIONS[0].value;
}

function buildRuleClausesForSave(form = {}) {
  const clauses = Array.isArray(form.clauses)
    ? form.clauses.map((item) => normalizeClauseForEdit(item))
    : [];
  if (!hasPendingRuleClauseDraft(form)) {
    return {
      ok: true,
      clauses,
      message: ''
    };
  }

  const mergedConfigResult = mergePendingTemplateConfig(form);
  if (!mergedConfigResult.ok) {
    return {
      ok: false,
      clauses,
      message: mergedConfigResult.message
    };
  }

  const clauseScope = String(form.clauseScope || RULE_SCOPE_OPTIONS[0].value);
  const targetIdentityId = String(form.clauseTargetIdentityId || '').trim();
  const targetIdentity = String(form.clauseTargetIdentity || '').trim();
  if (clauseScope !== 'all_people' && clauseScope.indexOf('_all') === -1 && !targetIdentityId) {
    return {
      ok: false,
      clauses,
      message: localeCopy.copy_7151fd51a0
    };
  }

  const nextClause = {
    scopeType: clauseScope,
    scopeLabel: getScopeLabel(clauseScope),
    targetIdentityId,
    targetIdentity,
    requireAllComplete: form.clauseRequireAllComplete === true,
    templateConfigs: mergedConfigResult.templateConfigs
  };
  const editingIndex = Number(form.clauseEditingIndex);
  if (editingIndex >= 0 && clauses[editingIndex]) {
    clauses[editingIndex] = nextClause;
  } else {
    const exists = clauses.some((item) => (
      item.scopeType === nextClause.scopeType
      && item.targetIdentityId === nextClause.targetIdentityId
      && item.requireAllComplete === nextClause.requireAllComplete
      && JSON.stringify(item.templateConfigs || []) === JSON.stringify(nextClause.templateConfigs)
    ));
    if (!exists) {
      clauses.push(nextClause);
    }
  }

  return {
    ok: true,
    clauses,
    message: ''
  };
}

function buildRuleClausesForBatchApply(form = {}) {
  const clauses = Array.isArray(form.clauses)
    ? form.clauses.map((item) => normalizeClauseForEdit(item))
    : [];
  return {
    ok: clauses.length > 0,
    clauses,
    message: clauses.length ? '' : localeCopy.copy_30a324d851
  };
}

function buildRuleClauseText(clause = {}) {
  const scopeText = clause.scopeLabel || getScopeLabel(clause.scopeType) || localeCopy.copy_f8d4dcaa31;
  const identityText = clause.targetIdentity ? localeFormat(localeCopy.copy_2603da8ac7, [clause.targetIdentity]) : '';
  const completeText = clause.requireAllComplete ? localeCopy.copy_a610bcb008 : localeCopy.copy_67c8d6955e;
  const questionText = (clause.templateConfigs || []).length
    ? (clause.templateConfigs || [])
      .map((config) => localeFormat(localeCopy.copy_6a6e8afeff, [config.templateName || localeCopy.copy_a3c996a525, config.weight, config.sortOrder]))
      .join('、')
    : localeCopy.copy_52740940a5;
  return `${scopeText}${identityText}${completeText} [${questionText}]`;
}

function buildRuleListItem(rule = {}) {
  const clauses = (rule.clauses || []).map((item) => normalizeClauseForEdit(item));
  return {
    id: String(rule.id || '').trim(),
    activityId: String(rule.activityId || '').trim(),
    activityName: String(rule.activityName || '').trim(),
    scorerDepartmentId: String(rule.scorerDepartmentId || '').trim(),
    scorerDepartment: String(rule.scorerDepartment || '').trim(),
    scorerIdentityId: String(rule.scorerIdentityId || '').trim(),
    scorerIdentity: String(rule.scorerIdentity || '').trim(),
    clauses,
    ruleCount: clauses.length,
    clausesText: clauses.length
      ? clauses.map((clause) => buildRuleClauseText(clause)).join(' | ')
      : localeCopy.copy_06c9003301
  };
}

function markSelectedRules(ruleList = [], selectedRuleIds = []) {
  const selectedIdSet = new Set((selectedRuleIds || []).map((item) => String(item)));
  return (ruleList || []).map((item) => ({
    ...item,
    isSelected: selectedIdSet.has(String(item.id || ''))
  }));
}

function createSelectedRuleIdMap(selectedRuleIds = []) {
  return (selectedRuleIds || []).reduce((map, item) => {
    const id = String(item || '').trim();
    if (id) {
      map[id] = true;
    }
    return map;
  }, {});
}

function emptyRuleFilters() {
  return {
    department: localeCopy.copy_31d4595959,
    identity: localeCopy.copy_31d4595959
  };
}

function buildRuleFilterOptions(ruleList = []) {
  const departments = [];
  const identities = [];
  const departmentSet = new Set();
  const identitySet = new Set();

  (ruleList || []).forEach((item) => {
    const department = String(item.scorerDepartment || '').trim();
    const identity = String(item.scorerIdentity || '').trim();
    if (department && !departmentSet.has(department)) {
      departmentSet.add(department);
      departments.push(department);
    }
    if (identity && !identitySet.has(identity)) {
      identitySet.add(identity);
      identities.push(identity);
    }
  });

  return {
    departments: [localeCopy.copy_31d4595959, ...departments.sort((a, b) => a.localeCompare(b, 'zh-CN'))],
    identities: [localeCopy.copy_31d4595959, ...identities.sort((a, b) => a.localeCompare(b, 'zh-CN'))]
  };
}

function normalizeRuleFilters(filters = {}, filterOptions = buildRuleFilterOptions()) {
  const department = (filterOptions.departments || []).includes(filters.department) ? filters.department : localeCopy.copy_31d4595959;
  const identity = (filterOptions.identities || []).includes(filters.identity) ? filters.identity : localeCopy.copy_31d4595959;
  return {
    department,
    identity
  };
}

function filterRuleList(ruleList = [], filters = emptyRuleFilters()) {
  return (ruleList || []).filter((item) => {
    const departmentMatched = !filters.department
      || filters.department === localeCopy.copy_31d4595959
      || String(item.scorerDepartment || '') === filters.department;
    const identityMatched = !filters.identity
      || filters.identity === localeCopy.copy_31d4595959
      || String(item.scorerIdentity || '') === filters.identity;
    return departmentMatched && identityMatched;
  });
}

function buildResultFilterOptions(values = []) {
  return [localeCopy.copy_31d4595959, ...values.filter(Boolean)];
}

function showShortToast(title, icon = 'none') {
  wx.showToast({
    title,
    icon
  });
}

function getErrorText(error, fallback) {
  if (error && (error.silent || error.status === 'request_cancelled')) return '';
  const text = String((error && error.message) || '').trim();
  return text || fallback;
}

const HR_PROFILE_SEARCH_FIELDS = [
  { value: 'all', label: localeCopy.hrSearchAllCore },
  { value: 'name', label: localeCopy.hrSearchName },
  { value: 'studentId', label: localeCopy.hrSearchStudentId },
  { value: 'assignmentNature', label: localeCopy.hrAssignmentNature },
  { value: 'department', label: localeCopy.hrSearchDepartment },
  { value: 'identity', label: localeCopy.hrSearchIdentity },
  { value: 'workGroup', label: localeCopy.hrSearchWorkGroup },
  { value: 'membershipStatus', label: localeCopy.hrSearchMembershipStatus },
  { value: 'accountStatus', label: localeCopy.hrSearchAccountStatus },
  { value: 'profileStatus', label: localeCopy.hrSearchProfileStatus }
];

const HR_PROFILE_SORT_OPTIONS = [
  { value: 'name_asc', label: localeCopy.hrSortNameAsc },
  { value: 'student_id_asc', label: localeCopy.hrSortStudentIdAsc },
  { value: 'membership_status', label: localeCopy.hrSortMembershipStatus },
  { value: 'assignment_count_desc', label: localeCopy.hrSortAssignmentCount },
  { value: 'profile_status', label: localeCopy.hrSortProfileStatus },
  { value: 'joined_at_desc', label: localeCopy.hrSortJoinedAt },
  { value: 'left_at_desc', label: localeCopy.hrSortLeftAt }
];
const HR_PROFILE_STATUS_OPTIONS = [
  localeCopy.hrProfilePending,
  localeCopy.hrProfileApproved,
  localeCopy.hrProfileRejected,
  localeCopy.hrProfileNone
];

function emptyHrProfileFilters() {
  return {
    searchField: 'all',
    keyword: '',
    membershipStatuses: [],
    positionStates: [],
    assignmentNatures: [],
    departments: [],
    identities: [],
    workGroups: [],
    profileStatuses: [],
    completenessStates: [],
    accountStates: [],
    bindingStates: [],
    sortMode: 'name_asc'
  };
}

function emptyHrProfileFilterOptions() {
  return {
    searchFields: HR_PROFILE_SEARCH_FIELDS,
    sortModes: HR_PROFILE_SORT_OPTIONS,
    membershipStatuses: [],
    positionStates: [],
    assignmentNatures: [],
    departments: [],
    identities: [],
    workGroups: [],
    profileStatuses: [],
    completenessStates: [],
    accountStates: [],
    bindingStates: []
  };
}

function getHrProfileStatusOrder(auditStatus) {
  if (auditStatus === 'pending') {
    return 0;
  }
  if (auditStatus === 'none') {
    return 1;
  }
  if (auditStatus === 'approved') {
    return 2;
  }
  return 3;
}

function normalizeAssignmentFilterTuple(assignment) {
  const source = assignment || {};
  const department = String(source.department || source.departmentName || '');
  const identity = String(source.identityCategoryName || source.identity || source.identityName || '');
  const workGroup = String(source.workGroup || source.workGroupName || '');
  const departmentId = String(source.departmentId || '');
  const identityCategoryId = String(source.identityCategoryId || source.identityId || '');
  const workGroupId = String(source.workGroupId || '');
  const departmentValue = departmentId || (department ? 'legacy-department:' + department : '');
  const identityValue = identityCategoryId || (identity ? 'legacy-identity:' + identity : '');
  const workGroupValue = workGroupId || (workGroup
    ? 'legacy-work-group:' + (departmentId || department) + ':' + workGroup
    : '');
  return {
    assignmentNature: String(source.assignmentNature || source.assignmentKind || 'staff'),
    department,
    departmentValue,
    identity,
    identityValue,
    workGroup,
    workGroupValue
  };
}

function addFilterOption(optionMap, value, label) {
  if (!value || !label || optionMap.has(value)) return;
  optionMap.set(value, { value, label });
}

function buildHrProfileFilterOptions(rows = []) {
  const departments = new Map();
  const identities = new Map();
  const workGroups = new Map();

  rows.forEach((item) => {
    const assignments = Array.isArray(item.assignments) ? item.assignments : [];
    assignments.forEach((assignment) => {
      const tuple = normalizeAssignmentFilterTuple(assignment);
      addFilterOption(departments, tuple.departmentValue, tuple.department);
      addFilterOption(identities, tuple.identityValue, tuple.identity);
      addFilterOption(
        workGroups,
        tuple.workGroupValue,
        tuple.workGroup && tuple.department ? tuple.workGroup + ' · ' + tuple.department : tuple.workGroup
      );
    });
  });

  const option = (value, label) => ({ value, label });
  const sortOptions = (optionMap) => Array.from(optionMap.values()).sort((a, b) => (
    String(a.label).localeCompare(String(b.label), 'zh-CN') || String(a.value).localeCompare(String(b.value))
  ));
  return {
    searchFields: HR_PROFILE_SEARCH_FIELDS,
    sortModes: HR_PROFILE_SORT_OPTIONS,
    membershipStatuses: [option('active', localeCopy.hrMembershipActive), option('left', localeCopy.hrMembershipLeft)],
    positionStates: [option('with_position', localeCopy.hrWithPosition), option('without_position', localeCopy.hrWithoutPosition)],
    assignmentNatures: [option('staff', localeCopy.hrNatureStaff), option('liaison', localeCopy.hrNatureLiaison), option('other', localeCopy.hrNatureOther)],
    departments: sortOptions(departments),
    identities: sortOptions(identities),
    workGroups: sortOptions(workGroups),
    profileStatuses: [
      option('pending', localeCopy.hrProfilePending), option('approved', localeCopy.hrProfileApproved),
      option('rejected', localeCopy.hrProfileRejected), option('none', localeCopy.hrProfileNone)
    ],
    completenessStates: [option('complete', localeCopy.hrProfileComplete), option('incomplete', localeCopy.hrProfileIncomplete)],
    accountStates: [
      option('verified', localeCopy.hrAccountActive),
      option('pending_verification', localeCopy.hrAccountPendingVerification),
      option('recovery_required', localeCopy.hrAccountRecoveryRequired),
      option('frozen', localeCopy.hrAccountFrozen),
      option('unbound', localeCopy.hrAccountUnbound),
      option('unknown', localeCopy.hrAccountUnknown)
    ],
    bindingStates: [option('bound', localeCopy.hrBindingBound), option('unbound', localeCopy.hrBindingUnbound)]
  };
}

function applyHrProfileFilters(rows = [], filters = emptyHrProfileFilters()) {
  const keyword = String(filters.keyword || '').trim().toLowerCase();
  const selected = (key) => Array.isArray(filters[key]) ? filters[key] : [];
  const includesSelected = (key, value) => !selected(key).length || selected(key).includes(value);
  const assignmentKinds = { staff: localeCopy.hrNatureStaff, liaison: localeCopy.hrNatureLiaison, other: localeCopy.hrNatureOther };
  const filtered = (rows || []).filter((item) => {
    if (!includesSelected('membershipStatuses', item.membershipStatus || 'active')) return false;
    if (!includesSelected('positionStates', Number(item.assignmentCount || 0) > 0 ? 'with_position' : 'without_position')) return false;
    if (!includesSelected('profileStatuses', item.auditStatus || 'none')) return false;
    if (!includesSelected('completenessStates', item.isComplete ? 'complete' : 'incomplete')) return false;
    if (!includesSelected('accountStates', item.accountState || 'unbound')) return false;
    if (!includesSelected('bindingStates', item.wxBindStatus === 'bound' ? 'bound' : 'unbound')) return false;
    const assignmentFiltersActive = selected('assignmentNatures').length || selected('departments').length
      || selected('identities').length || selected('workGroups').length;
    const assignments = Array.isArray(item.assignments) ? item.assignments : [];
    const tupleMatchesFilters = (assignment) => {
      const tuple = normalizeAssignmentFilterTuple(assignment);
      const includesTupleValue = (key, value) => !selected(key).length
        || selected(key).includes(value);
      return includesSelected('assignmentNatures', tuple.assignmentNature)
        && includesTupleValue('departments', tuple.departmentValue)
        && includesTupleValue('identities', tuple.identityValue)
        && includesTupleValue('workGroups', tuple.workGroupValue);
    };
    const matchingAssignments = assignmentFiltersActive
      ? assignments.filter(tupleMatchesFilters)
      : assignments;
    if (assignmentFiltersActive && !matchingAssignments.length) return false;
    if (keyword) {
      const assignmentText = matchingAssignments.map((assignment) => [
        assignmentKinds[assignment.assignmentNature] || assignment.assignmentNature,
        assignment.department, assignment.identityCategoryName, assignment.workGroup
      ].filter(Boolean).join(' ')).join(' ');
      const searchValues = {
        name: item.name,
        studentId: item.studentId,
        assignmentNature: (item.assignmentNatures || []).map((value) => assignmentKinds[value] || value).join(' '),
        department: (item.departments || []).join(' '),
        identity: (item.identities || []).join(' '),
        workGroup: (item.workGroups || []).join(' '),
        membershipStatus: item.membershipStatusText,
        accountStatus: item.accountStateText,
        profileStatus: item.auditStatusText
      };
      const field = filters.searchField || 'all';
      const assignmentFieldValues = {
        assignmentNature: matchingAssignments.map((assignment) => assignmentKinds[assignment.assignmentNature] || assignment.assignmentNature).join(' '),
        department: matchingAssignments.map((assignment) => assignment.department || '').join(' '),
        identity: matchingAssignments.map((assignment) => assignment.identityCategoryName || assignment.identity || '').join(' '),
        workGroup: matchingAssignments.map((assignment) => assignment.workGroup || '').join(' ')
      };
      const haystack = field === 'all'
        ? [item.name, item.studentId, assignmentText, item.membershipStatusText, item.accountStateText, item.auditStatusText].join(' ')
        : (Object.prototype.hasOwnProperty.call(assignmentFieldValues, field)
          ? assignmentFieldValues[field]
          : searchValues[field]);
      if (!String(haystack || '').toLowerCase().includes(keyword)) return false;
    }
    return true;
  });
  const dateValue = (value) => value ? new Date(value).getTime() || 0 : 0;
  return filtered.sort((a, b) => {
    const mode = filters.sortMode || 'name_asc';
    if (mode === 'student_id_asc') return String(a.studentId || '').localeCompare(String(b.studentId || ''), 'zh-CN');
    if (mode === 'membership_status') return String(a.membershipStatus || '').localeCompare(String(b.membershipStatus || '')) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    if (mode === 'assignment_count_desc') return Number(b.assignmentCount || 0) - Number(a.assignmentCount || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    if (mode === 'profile_status') return getHrProfileStatusOrder(a.auditStatus) - getHrProfileStatusOrder(b.auditStatus) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    if (mode === 'joined_at_desc') return dateValue(b.joinedAt) - dateValue(a.joinedAt) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    if (mode === 'left_at_desc') return dateValue(b.leftAt) - dateValue(a.leftAt) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
}

function emptyResultFilters() {
  return {
    department: localeCopy.copy_31d4595959,
    identity: localeCopy.copy_31d4595959,
    workGroup: localeCopy.copy_31d4595959,
    viewMode: 'overview',
    sortMode: 'score_desc'
  };
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const [year, month, day] = value.split('-').map((item) => Number(item));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

function getNumericLength(value) {
  return String(value || '').replace(/^[+-]/, '').replace('.', '').length;
}

function getProfileFieldTypeLabel(type) {
  if (type === 'number') {
    return localeCopy.copy_dfb6c2130f;
  }
  if (type === 'sequence') {
    return localeCopy.copy_5f0b7c7728;
  }
  if (type === 'date') {
    return localeCopy.copy_45d46b9df2;
  }
  if (type === 'phone') {
    return localeCopy.copy_8e0c2b3066;
  }
  if (type === 'email') {
    return localeCopy.copy_138db9568c;
  }
  return localeCopy.copy_7dd268a8b6;
}

function buildFieldHint(field = {}) {
  if (field.type === 'text' && ((field.minLength != null && field.minLength !== '') || (field.maxLength != null && field.maxLength !== ''))) {
    const parts = [];
    if (field.minLength != null && field.minLength !== '') {
      parts.push(localeFormat(localeCopy.copy_3f8754b30b, [field.minLength]));
    }
    if (field.maxLength != null && field.maxLength !== '') {
      parts.push(localeFormat(localeCopy.copy_451c378411, [field.maxLength]));
    }
    return localeFormat(localeCopy.copy_4be5ecab0a, [parts.join('，')]);
  }

  if (field.type === 'number') {
    const decimalText = field.allowDecimal === false ? localeCopy.copy_a3dea6ada5 : localeCopy.copy_ad3542efbf;
    if (field.numberRule === 'length_range' && ((field.minDigits != null && field.minDigits !== '') || (field.maxDigits != null && field.maxDigits !== ''))) {
      const parts = [];
      if (field.minDigits != null && field.minDigits !== '') {
        parts.push(localeFormat(localeCopy.copy_3f8754b30b, [field.minDigits]));
      }
      if (field.maxDigits != null && field.maxDigits !== '') {
        parts.push(localeFormat(localeCopy.copy_451c378411, [field.maxDigits]));
      }
      return localeFormat(localeCopy.copy_d55da089ba, [parts.join('，'), decimalText]);
    }
    if ((field.minValue != null && field.minValue !== '') || (field.maxValue != null && field.maxValue !== '')) {
      const parts = [];
      if (field.minValue != null && field.minValue !== '') {
        parts.push(localeFormat(localeCopy.copy_82f906c927, [field.minValue]));
      }
      if (field.maxValue != null && field.maxValue !== '') {
        parts.push(localeFormat(localeCopy.copy_5a2de860a6, [field.maxValue]));
      }
      return localeFormat(localeCopy.copy_62b07016a8, [parts.join('，'), decimalText]);
    }
    return decimalText;
  }

  if (field.type === 'date') {
    return localeCopy.copy_fd57aa07b7;
  }

  if (field.type === 'phone') {
    return localeCopy.copy_388528b146;
  }

  if (field.type === 'email') {
    return localeCopy.copy_4dbdb20d7c;
  }

  return '';
}

function validateProfileField(field = {}, rawValue) {
  const value = normalizeEmptyValue(rawValue);

  if (!value) {
    return '';
  }

  if (field.type === 'text') {
    const characterCount = Array.from(value).length;
    if (field.minLength != null && field.minLength !== '' && characterCount < field.minLength) {
      return localeFormat(localeCopy.copy_245abb6cb3, [field.label, field.minLength]);
    }
    if (field.maxLength != null && field.maxLength !== '' && characterCount > field.maxLength) {
      return localeFormat(localeCopy.copy_0d42479c01, [field.label, field.maxLength]);
    }
  }

  if (field.type === 'number') {
    if (field.allowDecimal === false && !/^[+-]?\d+$/.test(value)) {
      return localeFormat(localeCopy.copy_8d49f37a37, [field.label]);
    }
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return localeFormat(localeCopy.copy_952bf81d5f, [field.label]);
    }
    if (field.numberRule === 'length_range') {
      const numericLength = getNumericLength(value);
      if (field.minDigits != null && field.minDigits !== '' && numericLength < field.minDigits) {
        return localeFormat(localeCopy.copy_8d415deaa0, [field.label, field.minDigits]);
      }
      if (field.maxDigits != null && field.maxDigits !== '' && numericLength > field.maxDigits) {
        return localeFormat(localeCopy.copy_8ce15854f9, [field.label, field.maxDigits]);
      }
    } else {
      if (field.minValue != null && field.minValue !== '' && numberValue < field.minValue) {
        return localeFormat(localeCopy.copy_2c1cbd4cee, [field.label, field.minValue]);
      }
      if (field.maxValue != null && field.maxValue !== '' && numberValue > field.maxValue) {
        return localeFormat(localeCopy.copy_3f2df8f2ed, [field.label, field.maxValue]);
      }
    }
  }

  if (field.type === 'sequence' && Array.isArray(field.options) && field.options.length && field.options.indexOf(value) === -1) {
    return localeFormat(localeCopy.copy_8a0bd4d5b9, [field.label]);
  }

  if (field.type === 'date' && !isValidDateString(value)) {
    return localeFormat(localeCopy.copy_993602ff18, [field.label]);
  }

  if (field.type === 'phone' && !/^1[3-9]\d{9}$/.test(value)) {
    return localeFormat(localeCopy.copy_9973008adb, [field.label]);
  }

  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return localeFormat(localeCopy.copy_9973008adb, [field.label]);
  }

  return '';
}

function tryParseDateValue(value) {
  let v = String(value || '').trim();
  if (!v) return null;

  let m1 = v.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (m1) {
    let year = Number(m1[1]);
    let month = Number(m1[2]);
    let day = Number(m1[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let dt = new Date(Date.UTC(year, month - 1, day));
      if (dt.getUTCFullYear() === year && dt.getUTCMonth() + 1 === month && dt.getUTCDate() === day) {
        return { year: year, month: month, day: day };
      }
    }
  }

  return null;
}

function detectFieldTypeFromValues(values) {
  let nonEmpty = (values || []).filter(function (v) { return String(v || '').trim() !== ''; });
  if (!nonEmpty.length) return 'text';

  let allDate = true;
  let allPhone = true;
  let allEmail = true;
  let allNumber = true;

  for (let i = 0; i < nonEmpty.length; i++) {
    let v = String(nonEmpty[i]).trim();
    if (!tryParseDateValue(v)) allDate = false;
    if (!/^1[3-9]\d{9}$/.test(v)) allPhone = false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) allEmail = false;
    if (!isFinite(Number(v)) || v === '') allNumber = false;
  }

  if (allDate) return 'date';
  if (allPhone) return 'phone';
  if (allEmail) return 'email';
  if (allNumber) return 'number';
  return 'text';
}

let EMPTY_VALUE_ALIASES = ['null', 'NULL', 'Null', localeCopy.copy_54e953f1bb, localeCopy.copy_da3d159c7a, 'N/A', 'NA', 'n/a', 'na', '-', '—', 'none', 'None', '/', '\\'];

function normalizeEmptyValue(value) {
  let v = String(value == null ? '' : value).trim();
  if (!v) return '';
  if (EMPTY_VALUE_ALIASES.indexOf(v) !== -1) return '';
  return v;
}

function getFieldTypeDisplayName(fieldDef) {
  let ft = (fieldDef && fieldDef.type) || 'text';
  let option = PROFILE_FIELD_TYPE_OPTIONS.find(function (item) { return item.value === ft; });
  return option ? option.label : localeCopy.copy_12e5c96d1e;
}

function getFieldTypeLabelForTarget(target, templateFields) {
  if (!target || target === 'ignore') return '—';
  if (target === 'name' || target === 'studentId' || target === 'department'
      || target === 'identity' || target === 'workGroup') {
    return localeCopy.copy_12e5c96d1e;
  }
  let fields = templateFields || [];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].id === target) return getFieldTypeDisplayName(fields[i]);
  }
  return localeCopy.copy_12e5c96d1e;
}

function validateCsvValueAgainstField(value, fieldDef) {
  let v = normalizeEmptyValue(value);
  let fieldType = (fieldDef && fieldDef.type) || 'text';
  let typeLabel = getFieldTypeDisplayName(fieldDef);

  if (!v) return { ok: true };

  if (fieldType === 'text') {
    if (fieldDef.minLength && v.length < Number(fieldDef.minLength)) {
      return { ok: false, reason: localeCopy.copy_75b9fa45e1 + fieldDef.minLength + localeCopy.copy_32f0d98c34, fieldType: typeLabel };
    }
    if (fieldDef.maxLength && v.length > Number(fieldDef.maxLength)) {
      return { ok: false, reason: localeCopy.copy_b882dba21a + fieldDef.maxLength + localeCopy.copy_b4e32a17b0, fieldType: typeLabel };
    }
    return { ok: true };
  }

  if (fieldType === 'number') {
    if (fieldDef.allowDecimal === false && !/^[+-]?\d+$/.test(v)) {
      return { ok: false, reason: localeCopy.copy_007b4d4286, fieldType: typeLabel };
    }
    let num = Number(v);
    if (!isFinite(num)) return { ok: false, reason: localeCopy.copy_d208f302ad, fieldType: typeLabel };
    if (fieldDef.numberRule === 'length_range') {
      let nlen = String(v).replace(/^[+-]/, '').replace('.', '').length;
      if (fieldDef.minDigits && nlen < Number(fieldDef.minDigits)) {
        return { ok: false, reason: localeCopy.copy_1f410a2c02 + fieldDef.minDigits + localeCopy.copy_b75c3b7064, fieldType: typeLabel };
      }
      if (fieldDef.maxDigits && nlen > Number(fieldDef.maxDigits)) {
        return { ok: false, reason: localeCopy.copy_48c9426863 + fieldDef.maxDigits + localeCopy.copy_b75c3b7064, fieldType: typeLabel };
      }
    } else {
      if (fieldDef.minValue !== '' && fieldDef.minValue != null && num < Number(fieldDef.minValue)) {
        return { ok: false, reason: localeCopy.copy_7beca82ea5 + fieldDef.minValue + localeCopy.copy_8a85cc9b8b, fieldType: typeLabel };
      }
      if (fieldDef.maxValue !== '' && fieldDef.maxValue != null && num > Number(fieldDef.maxValue)) {
        return { ok: false, reason: localeCopy.copy_144ee0fab3 + fieldDef.maxValue + localeCopy.copy_8a85cc9b8b, fieldType: typeLabel };
      }
    }
    return { ok: true };
  }

  if (fieldType === 'sequence') {
    let optionsArr = [];
    if (Array.isArray(fieldDef.options)) {
      optionsArr = fieldDef.options;
    } else if (fieldDef.optionsText) {
      optionsArr = String(fieldDef.optionsText).split(/[\n,]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    }
    if (optionsArr.length && optionsArr.indexOf(v) === -1) {
      return { ok: false, reason: localeCopy.copy_821b3229b0, fieldType: typeLabel };
    }
    return { ok: true };
  }

  if (fieldType === 'date') {
    if (!tryParseDateValue(v)) return { ok: false, reason: localeCopy.copy_a1eb0bc51c, fieldType: typeLabel };
    return { ok: true };
  }

  if (fieldType === 'phone') {
    if (!/^1[3-9]\d{9}$/.test(v)) return { ok: false, reason: localeCopy.copy_332cb0e0e9, fieldType: typeLabel };
    return { ok: true };
  }

  if (fieldType === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, reason: localeCopy.copy_0ce7e15a71, fieldType: typeLabel };
    return { ok: true };
  }

  return { ok: true };
}

function jaccardCharSimilarity(a, b) {
  let sa = String(a || '').trim().toLowerCase();
  let sb = String(b || '').trim().toLowerCase();
  if (!sa || !sb) return 0;
  let setA = {}, setB = {};
  for (let i = 0; i < sa.length; i++) { setA[sa[i]] = true; }
  for (let i = 0; i < sb.length; i++) { setB[sb[i]] = true; }
  let intersection = 0, union = 0;
  let seen = {};
  for (let k in setA) { seen[k] = true; }
  for (let k in setB) { seen[k] = true; }
  for (let k in seen) {
    if (setA[k] && setB[k]) intersection++;
    union++;
  }
  return union === 0 ? 0 : intersection / union;
}

function autoMapCsvColumn(headerName, templateFields) {
  let h = String(headerName || '').trim().toLowerCase();
  if (!h) return 'ignore';
  let MIN_SIMILARITY = 0.4;

  let basicCandidates = [
    { target: 'name', aliases: [localeCopy.copy_3c946202ff, 'name'] },
    { target: 'studentId', aliases: [localeCopy.copy_cbb853db1b, 'studentid', 'student id'] },
    { target: 'department', aliases: [localeCopy.copy_027e560285, localeCopy.copy_62f8e70200, localeCopy.copy_bc011e4e3b, localeCopy.copy_a98e7f3519, 'department'] },
    { target: 'identity', aliases: [localeCopy.copy_51b18db06b, localeCopy.copy_474f638a6f, 'identity'] },
    { target: 'workGroup', aliases: [localeCopy.copy_6e82088dd6, localeCopy.copy_be736f763d, localeCopy.copy_7b66955494, 'workgroup', 'work group'] }
  ];

  function scoreCandidates(candidates, source) {
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      let cand = candidates[i];
      let aliases = cand.aliases || [cand.label || ''];
      for (let j = 0; j < aliases.length; j++) {
        let alias = String(aliases[j] || '').trim().toLowerCase();
        if (!alias) continue;
        let score = 0;
        if (h === alias) {
          score = 1.0;
        } else if (h.indexOf(alias) >= 0 || alias.indexOf(h) >= 0) {
          score = 0.75;
        } else {
          score = jaccardCharSimilarity(h, alias);
        }
        if (score >= MIN_SIMILARITY) {
          if (!best || score > best.score) {
            best = { target: cand.target || cand.id, score: score, source: source };
          } else if (score === best.score && source === 'ext' && best.source === 'basic') {
            best = { target: cand.target || cand.id, score: score, source: source };
          }
        }
      }
    }
    return best;
  }

  let bestBasic = scoreCandidates(basicCandidates, 'basic');

  let extCandidates = [];
  let fields = templateFields || [];
  for (let i = 0; i < fields.length; i++) {
    extCandidates.push({ target: fields[i].id, aliases: [fields[i].label] });
  }
  let bestExt = scoreCandidates(extCandidates, 'ext');

  let winner = null;
  if (bestBasic && bestExt) {
    if (bestExt.score > bestBasic.score) {
      winner = bestExt;
    } else if (bestBasic.score > bestExt.score) {
      winner = bestBasic;
    } else {
      winner = bestExt;
    }
  } else {
    winner = bestBasic || bestExt;
  }

  return winner ? winner.target : 'ignore';
}

function buildCsvMappingOptions(templateFields) {
  let labels = [localeCopy.copy_d7f0ba5c5a, localeCopy.copy_3c946202ff, localeCopy.copy_cbb853db1b, localeCopy.copy_62f8e70200, localeCopy.copy_474f638a6f, localeCopy.copy_41b3f85916];
  let values = ['ignore', 'name', 'studentId', 'department', 'identity', 'workGroup'];
  let fields = templateFields || [];
  for (let i = 0; i < fields.length; i++) {
    labels.push('→ ' + fields[i].label + localeCopy.copy_06bb0a0ac7);
    values.push(fields[i].id);
  }
  return { labels: labels, values: values };
}

function getOptionIndex(values, target) {
  for (let i = 0; i < values.length; i++) {
    if (values[i] === target) return i;
  }
  return 0;
}

function refreshCsvMappingOptions(rows, templateFields) {
  let allOptions = buildCsvMappingOptions(templateFields);
  let occupiedTargets = {};
  let sourceRows = rows || [];
  for (let i = 0; i < sourceRows.length; i++) {
    let target = sourceRows[i] && sourceRows[i].target;
    if (target && target !== 'ignore') occupiedTargets[target] = i;
  }

  let nextRows = [];
  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex++) {
    let sourceRow = sourceRows[rowIndex] || {};
    let labels = [];
    let values = [];
    for (let optionIndex = 0; optionIndex < allOptions.values.length; optionIndex++) {
      let value = allOptions.values[optionIndex];
      if (value !== 'ignore' && occupiedTargets[value] !== undefined && occupiedTargets[value] !== rowIndex) {
        continue;
      }
      labels.push(allOptions.labels[optionIndex]);
      values.push(value);
    }
    let target = sourceRow.target || 'ignore';
    if (values.indexOf(target) === -1) target = 'ignore';
    let currentOptionIndex = getOptionIndex(values, target);
    nextRows.push({
      columnIndex: sourceRow.columnIndex,
      columnKey: sourceRow.columnKey,
      header: sourceRow.header,
      target: target,
      fieldTypeLabel: getFieldTypeLabelForTarget(target, templateFields),
      sampleValue: sourceRow.sampleValue,
      mappingLabels: labels,
      mappingValues: values,
      optionIndex: currentOptionIndex,
      optionLabel: labels[currentOptionIndex] || labels[0] || localeCopy.copy_e19cf95e29
    });
  }
  return nextRows;
}

function buildCsvColumnMapping(headers, samples, templateFields) {
  let mapping = buildCsvMappingOptions(templateFields);
  let rows = [];
  let occupiedTargets = {};

  for (let i = 0; i < headers.length; i++) {
    let header = headers[i];
    let sampleValues = [];
    // samples[0] = header row, samples[1..N] = data rows, aligned by index
    for (let r = 1; r < Math.min(samples.length, 6); r++) {
      let dr = samples[r] || [];
      sampleValues.push(dr[i] || '');
    }

    let target = autoMapCsvColumn(header, templateFields);
    if (target !== 'ignore' && occupiedTargets[target] !== undefined) target = 'ignore';
    if (target !== 'ignore') occupiedTargets[target] = i;

    rows.push({
      columnIndex: i,
      columnKey: 'column-' + i,
      header: header,
      target: target,
      sampleValue: sampleValues.length > 0 ? String(sampleValues[0] || '').trim() : ''
    });
  }
  return {
    rows: refreshCsvMappingOptions(rows, templateFields),
    labels: mapping.labels,
    values: mapping.values
  };
}


module.exports = {
  TAB_LIST,
  TIMEZONE_OPTIONS,
  RULE_SCOPE_OPTIONS,
  VIEW_SCOPE_OPTIONS,
  VIEW_SCOPE_LABEL_MAP,
  PROFILE_EDIT_MODE_OPTIONS,
  PROFILE_FIELD_TYPE_OPTIONS,
  NUMBER_RULE_OPTIONS,
  RULE_SCOPE_LABEL_MAP,
  toNumber,
  TEMPLATE_CSV_FIELDS,
  _csvEscapeField,
  formatScoreFixed3,
  clampNumber,
  getProgressColor,
  buildProgressFillStyle,
  emptyRuleForm,
  emptyHrForm,
  createEmptyProfileField,
  emptyHrProfileTemplateForm,
  normalizeHrProfileFieldForForm,
  emptyAdminForm,
  emptyDepartmentForm,
  emptyWorkGroupForm,
  emptyIdentityForm,
  emptyActivityForm,
  createEmptyQuestion,
  normalizeTemplateQuestionForForm,
  emptyTemplateForm,
  createLocalInviteCode,
  createTemplateConfig,
  normalizeClauseForEdit,
  moveItem,
  refreshTemplateConfigSortOrder,
  getScopeLabel,
  normalizeTemplateConfigsForSave,
  buildPendingTemplateConfigForSave,
  mergePendingTemplateConfig,
  hasPendingRuleClauseDraft,
  buildRuleClausesForSave,
  buildRuleClausesForBatchApply,
  buildRuleClauseText,
  buildRuleListItem,
  markSelectedRules,
  createSelectedRuleIdMap,
  emptyRuleFilters,
  buildRuleFilterOptions,
  normalizeRuleFilters,
  filterRuleList,
  buildResultFilterOptions,
  showShortToast,
  getErrorText,
  HR_PROFILE_STATUS_OPTIONS,
  emptyHrProfileFilters,
  emptyHrProfileFilterOptions,
  getHrProfileStatusOrder,
  buildHrProfileFilterOptions,
  applyHrProfileFilters,
  normalizeAssignmentFilterTuple,
  emptyResultFilters,
  isValidDateString,
  getNumericLength,
  getProfileFieldTypeLabel,
  buildFieldHint,
  validateProfileField,
  tryParseDateValue,
  detectFieldTypeFromValues,
  normalizeEmptyValue,
  getFieldTypeDisplayName,
  getFieldTypeLabelForTarget,
  validateCsvValueAgainstField,
  jaccardCharSimilarity,
  autoMapCsvColumn,
  buildCsvMappingOptions,
  getOptionIndex,
  refreshCsvMappingOptions,
  buildCsvColumnMapping
};
