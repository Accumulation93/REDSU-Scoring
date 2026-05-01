const STORAGE_KEY = 'roleProfiles';
const TAB_LIST = ['activities', 'templates', 'rules', 'results', 'profile', 'hr', 'departments', 'workGroups', 'identities', 'admins', 'settings'];
const TIMEZONE_OPTIONS = [
  { value: -12, label: 'UTC-12 (国际日期变更线西)' },
  { value: -11, label: 'UTC-11 (中途岛)' },
  { value: -10, label: 'UTC-10 (夏威夷)' },
  { value: -9, label: 'UTC-9 (阿拉斯加)' },
  { value: -8, label: 'UTC-8 (洛杉矶)' },
  { value: -7, label: 'UTC-7 (丹佛)' },
  { value: -6, label: 'UTC-6 (芝加哥)' },
  { value: -5, label: 'UTC-5 (纽约)' },
  { value: -4, label: 'UTC-4 (圣地亚哥)' },
  { value: -3, label: 'UTC-3 (巴西利亚)' },
  { value: -2, label: 'UTC-2 (中大西洋)' },
  { value: -1, label: 'UTC-1 (亚速尔)' },
  { value: 0, label: 'UTC+0 (伦敦)' },
  { value: 1, label: 'UTC+1 (巴黎)' },
  { value: 2, label: 'UTC+2 (开罗)' },
  { value: 3, label: 'UTC+3 (莫斯科)' },
  { value: 4, label: 'UTC+4 (迪拜)' },
  { value: 5, label: 'UTC+5 (卡拉奇)' },
  { value: 6, label: 'UTC+6 (达卡)' },
  { value: 7, label: 'UTC+7 (曼谷)' },
  { value: 8, label: 'UTC+8 (北京/上海/香港)' },
  { value: 9, label: 'UTC+9 (东京)' },
  { value: 10, label: 'UTC+10 (悉尼)' },
  { value: 11, label: 'UTC+11 (所罗门群岛)' },
  { value: 12, label: 'UTC+12 (奥克兰)' }
];
const RULE_SCOPE_OPTIONS = [
  { value: 'same_department_identity', label: '同一部门内的指定身份成员' },
  { value: 'same_department_all', label: '同一部门内的所有成员' },
  { value: 'same_work_group_identity', label: '同一部门同一职能组内的指定身份成员' },
  { value: 'same_work_group_all', label: '同一部门同一职能组内的所有成员' },
  { value: 'identity_only', label: '全体成员中的指定身份' },
  { value: 'all_people', label: '全体成员' }
];
const PROFILE_EDIT_MODE_OPTIONS = [
  { value: 'direct', label: '允许直接修改' },
  { value: 'audit', label: '需审核修改' },
  { value: 'readonly', label: '不允许修改' }
];
const PROFILE_FIELD_TYPE_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'sequence', label: '序列' },
  { value: 'date', label: '日期' },
  { value: 'phone', label: '手机号' },
  { value: 'email', label: '邮箱' }
];
const NUMBER_RULE_OPTIONS = [
  { value: 'value_range', label: '按数值范围' },
  { value: 'length_range', label: '按长度范围' }
];

const RULE_SCOPE_LABEL_MAP = RULE_SCOPE_OPTIONS.reduce((map, item) => {
  map[item.value] = item.label;
  return map;
}, {});

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatScoreFixed3(value) {
  return toNumber(value, 0).toFixed(3);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerpNumber(a, b, t) {
  return a + (b - a) * t;
}

function mixRgb(from, to, t) {
  const clamped = clampNumber(t, 0, 1);
  const r = Math.round(lerpNumber(from[0], to[0], clamped));
  const g = Math.round(lerpNumber(from[1], to[1], clamped));
  const b = Math.round(lerpNumber(from[2], to[2], clamped));
  return `rgb(${r}, ${g}, ${b})`;
}

function getProgressColor(ratePercent) {
  const percent = clampNumber(toNumber(ratePercent, 0), 0, 100);
  const low = [239, 68, 68]; // red-500
  const mid = [249, 115, 22]; // orange-500
  const high = [34, 197, 94]; // green-500
  if (percent <= 50) {
    return mixRgb(low, mid, percent / 50);
  }
  return mixRgb(mid, high, (percent - 50) / 50);
}

function buildProgressFillStyle(ratePercent) {
  const percent = clampNumber(toNumber(ratePercent, 0), 0, 100);
  const color = getProgressColor(percent);
  return `width: ${percent}%; background: linear-gradient(90deg, rgba(255,255,255,0.26), ${color});`;
}

function emptyRuleForm() {
  return {
    id: '',
    scorerDepartmentId: '',
    scorerDepartment: '',
    scorerIdentityId: '',
    scorerIdentity: '',
    clauseScope: RULE_SCOPE_OPTIONS[0].value,
    clauseScopeLabel: RULE_SCOPE_OPTIONS[0].label,
    clauseTargetIdentityId: '',
    clauseTargetIdentity: '',
    clauseRequireAllComplete: false,
    clauseTemplateId: '',
    clauseTemplateName: '',
    clauseTemplateWeight: '1',
    clauseTemplateOrder: '',
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
    adminLevel: 'admin',
    inviteCode: ''
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
    endDate: ''
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
    questions: [createEmptyQuestion()]
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
    sortOrder: config.sortOrder == null ? '' : String(config.sortOrder)
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
      sortOrder: String(item.sortOrder || '').trim()
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
      message: '评分问题权重必须大于 0'
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
      sortOrder: String(sortOrderValue)
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
      message: '请填写被评分人身份'
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
    message: clauses.length ? '' : '请先准备好要批量应用的被评分人规则'
  };
}

function buildRuleClauseText(clause = {}) {
  const scopeText = clause.scopeLabel || getScopeLabel(clause.scopeType) || '未设置被评分范围';
  const identityText = clause.targetIdentity ? `，被评分人身份：${clause.targetIdentity}` : '';
  const completeText = clause.requireAllComplete ? '，要求全评后计入核算' : '，不要求全评';
  const questionText = (clause.templateConfigs || []).length
    ? (clause.templateConfigs || [])
      .map((config) => `${config.templateName || '未命名评分问题'}（权重：${config.weight}，顺序：${config.sortOrder}）`)
      .join('、')
    : '未配置评分问题';
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
      : '未配置被评分人规则'
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
    department: '全部',
    identity: '全部'
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
    departments: ['全部', ...departments.sort((a, b) => a.localeCompare(b, 'zh-CN'))],
    identities: ['全部', ...identities.sort((a, b) => a.localeCompare(b, 'zh-CN'))]
  };
}

function normalizeRuleFilters(filters = {}, filterOptions = buildRuleFilterOptions()) {
  const department = (filterOptions.departments || []).includes(filters.department) ? filters.department : '全部';
  const identity = (filterOptions.identities || []).includes(filters.identity) ? filters.identity : '全部';
  return {
    department,
    identity
  };
}

function filterRuleList(ruleList = [], filters = emptyRuleFilters()) {
  return (ruleList || []).filter((item) => {
    const departmentMatched = !filters.department
      || filters.department === '全部'
      || String(item.scorerDepartment || '') === filters.department;
    const identityMatched = !filters.identity
      || filters.identity === '全部'
      || String(item.scorerIdentity || '') === filters.identity;
    return departmentMatched && identityMatched;
  });
}

function buildResultFilterOptions(values = []) {
  return ['全部', ...values.filter(Boolean)];
}

function showShortToast(title, icon = 'none') {
  wx.showToast({
    title,
    icon
  });
}

function getErrorText(error, fallback) {
  const text = String((error && (error.errMsg || error.message)) || '').trim();
  return text || fallback;
}

const HR_PROFILE_STATUS_OPTIONS = ['全部状态', '待审核', '未提交', '已生效', '已驳回'];

function emptyHrProfileFilters() {
  return {
    department: '全部部门',
    identity: '全部身份',
    workGroup: '全部工作分工',
    status: '全部状态',
    keyword: ''
  };
}

function emptyHrProfileFilterOptions() {
  return {
    departments: ['全部部门'],
    identities: ['全部身份'],
    workGroups: ['全部工作分工'],
    statuses: HR_PROFILE_STATUS_OPTIONS
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

function buildHrProfileFilterOptions(rows = []) {
  const departments = [];
  const identities = [];
  const workGroups = [];

  rows.forEach((item) => {
    if (item.department) {
      departments.push(item.department);
    }
    if (item.identity) {
      identities.push(item.identity);
    }
    if (item.workGroup) {
      workGroups.push(item.workGroup);
    }
  });

  return {
    departments: ['全部部门', ...[...new Set(departments)].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))],
    identities: ['全部身份', ...[...new Set(identities)].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))],
    workGroups: ['全部工作分工', ...[...new Set(workGroups)].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))],
    statuses: HR_PROFILE_STATUS_OPTIONS
  };
}

function applyHrProfileFilters(rows = [], filters = emptyHrProfileFilters()) {
  const keyword = String(filters.keyword || '').trim().toLowerCase();
  return (rows || []).filter((item) => {
    if (filters.department !== '全部部门' && item.department !== filters.department) {
      return false;
    }
    if (filters.identity !== '全部身份' && item.identity !== filters.identity) {
      return false;
    }
    if (filters.workGroup !== '全部工作分工' && item.workGroup !== filters.workGroup) {
      return false;
    }
    if (filters.status !== '全部状态' && item.auditStatusText !== filters.status) {
      return false;
    }
    if (keyword) {
      const name = String(item.name || '').trim().toLowerCase();
      const studentId = String(item.studentId || '').trim().toLowerCase();
      if (!name.includes(keyword) && !studentId.includes(keyword)) {
        return false;
      }
    }
    return true;
  }).sort((a, b) => {
    const statusDiff = getHrProfileStatusOrder(a.auditStatus) - getHrProfileStatusOrder(b.auditStatus);
    if (statusDiff !== 0) {
      return statusDiff;
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
}

function emptyResultFilters() {
  return {
    department: '全部',
    identity: '全部',
    workGroup: '全部',
    viewMode: 'overview',
    sortMode: 'score_desc'
  };
}

Page({
  data: {
    user: null,
    hasPermission: false,
    isSuperAdmin: false,
    canManageAdmins: false,
    isRootAdmin: false,
    activeTab: TAB_LIST[0],
    loadingMap: {},
    organizationList: [],
    currentOrganizationId: null,
    currentOrganizationName: '',
    orgFormVisible: false,
    orgFormData: { name: '' },
    scopeOptions: RULE_SCOPE_OPTIONS,
    profileEditModeOptions: PROFILE_EDIT_MODE_OPTIONS,
    profileFieldTypeOptions: PROFILE_FIELD_TYPE_OPTIONS,
    numberRuleOptions: NUMBER_RULE_OPTIONS,
    adminLevelOptions: ['普通管理员', '超级管理员'],
    adminCandidateKeyword: '',
    adminCandidateList: [],
    activityForm: emptyActivityForm(),
    activityList: [],
    currentActivityId: '',
    currentActivityName: '',
    templateForm: emptyTemplateForm(),
    templateList: [],
    ruleForm: emptyRuleForm(),
    draggingClauseTemplateIndex: -1,
    ruleList: [],
    ruleListView: [],
    selectedRuleIds: [],
    selectedRuleIdMap: {},
    visibleRuleAllSelected: false,
    ruleFilters: emptyRuleFilters(),
    ruleFilterOptions: {
      departments: ['全部'],
      identities: ['全部']
    },
    resultFilters: emptyResultFilters(),
    resultFilterOptions: {
      departments: ['全部'],
      identities: ['全部'],
      workGroups: ['全部']
    },
    resultViewOptions: [
      { value: 'overview', label: '明细查看' },
      { value: 'completion', label: '完成率看板' }
    ],
    resultViewLabel: '明细查看',
    resultSortOptions: [
      { value: 'score_desc', label: '按分数从高到低' },
      { value: 'name_asc', label: '按姓名首字母' },
      { value: 'department_asc', label: '按所属部门' },
      { value: 'workGroup_asc', label: '按职能组' }
    ],
    resultSortLabel: '按分数从高到低',
    resultPagination: {
      overview: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      calculation: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      detail: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      completion: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      records: { page: 0, pageSize: 0, hasMore: true, total: 0 }
    },
    scoreResultsRaw: {
      overviewRows: [],
      calculationRows: [],
      detailRows: [],
      recordRows: [],
      scorerCompletionRows: [],
      completionBoards: {
        departments: []
      },
      stats: {}
    },
    scoreResultsView: {
      overviewRows: [],
      calculationRows: [],
      detailRows: [],
      recordRows: [],
      scorerCompletionRows: [],
      completionBoards: {
        departments: [],
        identities: [],
        workGroups: []
      }
    },
    selectedResultTarget: null,
    targetRecordRows: [],
    targetRecordLoading: false,
    recordDetailPopupVisible: false,
    recordDetail: null,
    expandedScoreLabelMap: {},
    selectedCompletionDepartment: '',
    departmentScorerRows: [],
    departmentScorerLoading: false,
    scorerTargetPopupVisible: false,
    scorerTargetPopupTitle: '',
    scorerTargetPopupLoading: false,
    scorerTargetPopupRows: [],
    hrProfileTemplateForm: emptyHrProfileTemplateForm(),
    hrProfileFilters: emptyHrProfileFilters(),
    hrProfileFilterOptions: emptyHrProfileFilterOptions(),
    hrProfileRawRows: [],
    hrProfileRows: [],
    hrForm: emptyHrForm(),
    hrList: [],
    adminForm: emptyAdminForm(),
    adminLevelIndex: 0,
    adminList: [],
    latestInviteCode: '',
    csvName: '',
    departmentForm: emptyDepartmentForm(),
    departmentList: [],
    workGroupForm: emptyWorkGroupForm(),
    workGroupList: [],
    identityForm: emptyIdentityForm(),
    identityList: [],
    departmentOptions: [],
    identityOptions: [],
    workGroupOptions: [],
    timezoneOptions: TIMEZONE_OPTIONS,
    timezoneIndex: 20,
    systemConfig: { timezone: 8 }
  },

  onShow() {
    this.bootstrapPage();
  },

  async bootstrapPage() {
    const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
    const adminProfile = roleProfiles.admin;
    const isSuperAdmin = !!adminProfile && adminProfile.adminLevel === 'super_admin';
    const isRootAdmin = !!adminProfile && adminProfile.adminLevel === 'root_admin';

    if (!adminProfile) {
      this.setData({
        user: null,
        hasPermission: false,
        isSuperAdmin: false,
        isRootAdmin: false,
        canManageAdmins: false
      });
      return;
    }

    const canManageAdmins = isSuperAdmin || isRootAdmin;

    this.setData({
      user: adminProfile,
      hasPermission: true,
      isSuperAdmin,
      isRootAdmin,
      canManageAdmins,
      resultFilterOptions: {
        departments: ['全部'],
        identities: ['全部'],
        workGroups: ['全部']
      },
      resultViewOptions: [
        { value: 'overview', label: '明细查看' },
        { value: 'completion', label: '完成率看板' }
      ],
      resultViewLabel: '明细查看',
      resultSortOptions: [
        { value: 'score_desc', label: '按分数从高到低' },
        { value: 'name_asc', label: '按姓名首字母' },
        { value: 'department_asc', label: '按所属部门' },
        { value: 'workGroup_asc', label: '按职能组' }
      ],
      resultSortLabel: '按分数从高到低',
      adminLevelOptions: isRootAdmin
        ? ['普通管理员', '超级管理员', '至高权限管理员']
        : ['普通管理员', '超级管理员']
    });

    await this.loadActivityList();
    this.loadTemplateList();
    this.loadRuleList();
    this.loadHrProfileAdminData();
    this.loadHrList();
    this.loadAdminList();
    this.loadSystemConfig();
    this.loadOrganizations();
    await this.loadDepartmentList();
    await this.loadWorkGroupList();
    await this.loadIdentityList();
    this.updateHrFormOptions();
  },

  setLoading(key, value) {
    this.setData({
      loadingMap: {
        ...this.data.loadingMap,
        [key]: value
      }
    });
  },

  switchTab(e) {
    const { tab } = e.currentTarget.dataset;
    if (TAB_LIST.indexOf(tab) === -1) {
      return;
    }
    this.setData({ activeTab: tab });
    if (tab === 'results') {
      if (!this.data.currentActivityId) {
        this.loadActivityList().then(() => {
          if (this.data.currentActivityId) {
            this.loadScoreResults();
          }
        });
      } else {
        this.loadScoreResults();
      }
    }
    if (tab === 'profile') {
      this.loadHrProfileAdminData();
    }
    if (tab === 'departments') {
      this.loadDepartmentList();
    }
    if (tab === 'workGroups') {
      this.loadWorkGroupList();
    }
    if (tab === 'identities') {
      this.loadIdentityList();
    }
    if (tab === 'rules') {
      this.loadRuleList();
      if (!this.data.departmentList.length) {
        this.loadDepartmentList();
      }
      if (!this.data.identityList.length) {
        this.loadIdentityList();
      }
    }
    if (tab === 'settings') {
      this.loadSystemConfig();
    }
  },

  async loadSystemConfig() {
    try {
      const result = await this.callCloud('getSystemConfig');
      if (result.status === 'success' && result.config) {
        const timezone = result.config.timezone;
        const timezoneIndex = this.data.timezoneOptions.findIndex(function (item) {
          return item.value === timezone;
        });
        this.setData({
          systemConfig: { timezone: timezone },
          timezoneIndex: timezoneIndex >= 0 ? timezoneIndex : 20,
          currentOrganizationId: result.config.currentOrganization || null
        });
        this.resolveCurrentOrganizationName();
      }
    } catch (e) {
      console.error('loadSystemConfig error:', e);
    }
  },

  onTimezoneChange(e) {
    const idx = Number(e.detail.value);
    const option = this.data.timezoneOptions[idx];
    if (option) {
      this.setData({
        timezoneIndex: idx,
        systemConfig: { timezone: option.value }
      });
    }
  },

  async saveSystemConfig() {
    this.setLoading('saveSystemConfig', true);
    try {
      const result = await this.callCloud('saveSystemConfig', {
        timezone: this.data.systemConfig.timezone
      });
      if (result.status === 'success') {
        wx.showToast({ title: '配置已保存', icon: 'success' });
      } else {
        wx.showToast({ title: result.message || '保存失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setLoading('saveSystemConfig', false);
  },

  async loadOrganizations() {
    if (!this.data.isRootAdmin) return;
    try {
      const result = await this.callCloud('listOrganizations');
      if (result.status === 'success') {
        this.setData({ organizationList: result.list || [] });
        this.resolveCurrentOrganizationName();
      }
    } catch (e) {
      console.error('loadOrganizations error:', e);
    }
  },

  resolveCurrentOrganizationName() {
    const orgId = this.data.currentOrganizationId;
    if (!orgId) {
      this.setData({ currentOrganizationName: '' });
      return;
    }
    const org = this.data.organizationList.find(function (o) { return o.id === orgId; });
    this.setData({ currentOrganizationName: org ? org.name : '' });
  },

  openOrgForm(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id;
    if (id) {
      const org = this.data.organizationList.find(function (o) { return o.id === id; });
      this.setData({ orgFormVisible: true, orgFormData: { id, name: org ? org.name : '' } });
    } else {
      this.setData({ orgFormVisible: true, orgFormData: { name: '' } });
    }
  },

  closeOrgForm() {
    this.setData({ orgFormVisible: false, orgFormData: { name: '' } });
  },

  onOrgFieldInput(e) {
    this.setData({
      orgFormData: { ...this.data.orgFormData, name: e.detail.value.trim() }
    });
  },

  async saveOrganization() {
    if (!this.data.orgFormData.name) {
      wx.showToast({ title: '请填写组织名称', icon: 'none' });
      return;
    }
    this.setLoading('saveOrganization', true);
    try {
      const result = await this.callCloud('saveOrganization', this.data.orgFormData);
      if (result.status === 'success') {
        wx.showToast({ title: '组织已保存', icon: 'success' });
        this.closeOrgForm();
        await this.loadOrganizations();
      } else {
        wx.showToast({ title: result.message || '保存失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '保存组织失败', icon: 'none' });
    }
    this.setLoading('saveOrganization', false);
  },

  async deleteOrganization(e) {
    const organizationId = e.currentTarget.dataset.id;
    if (!organizationId) return;
    const confirm = await new Promise(function (resolve) {
      wx.showModal({
        title: '删除组织',
        content: '删除后将清除该组织在所有历史数据库中的数据，不可恢复。确认删除？',
        confirmText: '删除',
        cancelText: '取消',
        success: function (res) { resolve(res.confirm); }
      });
    });
    if (!confirm) return;
    this.setLoading('deleteOrganization', true);
    wx.showLoading({ title: '正在删除组织...', mask: true });
    try {
      const result = await this.callCloud('deleteOrganization', { organizationId });
      if (result.status === 'success') {
        wx.showToast({ title: '组织已删除', icon: 'success' });
        await this.loadOrganizations();
      } else {
        wx.showToast({ title: result.message || '删除失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '删除组织失败', icon: 'none' });
    }
    wx.hideLoading();
    this.setLoading('deleteOrganization', false);
  },

  async switchOrganization(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!id || !name) return;
    const confirm = await new Promise(function (resolve) {
      wx.showModal({
        title: '切换组织',
        content: '切换组织将归档当前所有数据到历史数据库，切换到「' + name + '」。如果这是历史组织，数据将被恢复。确认切换？',
        confirmText: '切换',
        cancelText: '取消',
        success: function (res) { resolve(res.confirm); }
      });
    });
    if (!confirm) return;

    this.setLoading('switchOrganization', true);

    // 第一步：归档当前数据
    wx.showLoading({ title: '正在归档当前数据...', mask: true });
    try {
      const archiveResult = await this.callCloud('switchOrganization', { mode: 'archive' });
      if (archiveResult.status !== 'success') {
        wx.hideLoading();
        wx.showToast({ title: archiveResult.message || '归档失败', icon: 'none' });
        this.setLoading('switchOrganization', false);
        return;
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '归档失败，请重试', icon: 'none' });
      this.setLoading('switchOrganization', false);
      return;
    }

    // 第二步：恢复目标组织
    wx.showLoading({ title: '正在恢复目标组织...', mask: true });
    try {
      const result = await this.callCloud('switchOrganization', {
        mode: 'restore',
        organizationId: id,
        organizationName: name
      });
      if (result.status === 'success') {
        wx.showToast({ title: result.message || '切换成功', icon: 'success' });
        this.setData({ currentOrganizationId: id, currentOrganizationName: name });
        await this.loadOrganizations();
        this.loadActivityList();
        this.loadTemplateList();
        this.loadRuleList();
        this.loadHrProfileAdminData();
        this.loadHrList();
        this.loadAdminList();
        await this.loadDepartmentList();
        await this.loadWorkGroupList();
        await this.loadIdentityList();
      } else {
        wx.showToast({ title: result.message || '恢复失败，请重试', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '恢复失败，当前数据已归档保存，请重试恢复步骤', icon: 'none' });
    }
    wx.hideLoading();
    this.setLoading('switchOrganization', false);
  },

  async createAndSwitchOrganization() {
    if (!this.data.orgFormData.name) {
      wx.showToast({ title: '请填写组织名称', icon: 'none' });
      return;
    }
    const confirm = await new Promise(function (resolve) {
      wx.showModal({
        title: '新建并切换组织',
        content: '当前所有数据将被归档到历史数据库，切换到新组织「' + this.data.orgFormData.name + '」。确认？',
        confirmText: '确认',
        cancelText: '取消',
        success: function (res) { resolve(res.confirm); }
      });
    }.bind(this));
    if (!confirm) return;
    const orgId = 'org_' + Date.now();

    this.setLoading('switchOrganization', true);

    // 第一步：归档当前数据
    wx.showLoading({ title: '正在归档当前数据...', mask: true });
    try {
      const archiveResult = await this.callCloud('switchOrganization', { mode: 'archive' });
      if (archiveResult.status !== 'success') {
        wx.hideLoading();
        wx.showToast({ title: archiveResult.message || '归档失败', icon: 'none' });
        this.setLoading('switchOrganization', false);
        return;
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '归档失败，请重试', icon: 'none' });
      this.setLoading('switchOrganization', false);
      return;
    }

    // 第二步：创建并恢复（新组织无历史数据，restore 仅创建组织记录）
    wx.showLoading({ title: '正在创建并切换组织...', mask: true });
    try {
      const result = await this.callCloud('switchOrganization', {
        mode: 'restore',
        organizationId: orgId,
        organizationName: this.data.orgFormData.name
      });
      if (result.status === 'success') {
        wx.showToast({ title: result.message || '切换成功', icon: 'success' });
        this.closeOrgForm();
        this.setData({ currentOrganizationId: orgId, currentOrganizationName: this.data.orgFormData.name });
        await this.loadOrganizations();
        this.loadActivityList();
        this.loadTemplateList();
        this.loadRuleList();
        this.loadHrProfileAdminData();
        this.loadHrList();
        this.loadAdminList();
        await this.loadDepartmentList();
        await this.loadWorkGroupList();
        await this.loadIdentityList();
      } else {
        wx.showToast({ title: result.message || '切换失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '切换失败，当前数据已归档保存，请重试', icon: 'none' });
    }
    wx.hideLoading();
    this.setLoading('switchOrganization', false);
  },

  callCloud(name, data = {}) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name,
        data,
        success: (res) => resolve(res.result || {}),
        fail: reject
      });
    });
  },

  setRuleListState(ruleList = [], selectedRuleIds = this.data.selectedRuleIds, filters = this.data.ruleFilters) {
    const normalizedList = (ruleList || []).map((item) => buildRuleListItem(item));
    const ruleIdSet = new Set(normalizedList.map((item) => item.id).filter(Boolean));
    const safeSelectedRuleIds = (selectedRuleIds || [])
      .map((item) => String(item || '').trim())
      .filter((id, index, list) => id && ruleIdSet.has(id) && list.indexOf(id) === index);
    const filterOptions = buildRuleFilterOptions(normalizedList);
    const nextFilters = normalizeRuleFilters(filters || emptyRuleFilters(), filterOptions);
    const selectedRuleIdMap = createSelectedRuleIdMap(safeSelectedRuleIds);
    const markedRuleList = markSelectedRules(normalizedList, safeSelectedRuleIds);
    const ruleListView = markSelectedRules(filterRuleList(normalizedList, nextFilters), safeSelectedRuleIds);
    const visibleRuleAllSelected = ruleListView.length > 0
      && ruleListView.every((item) => selectedRuleIdMap[String(item.id || '')]);

    this.setData({
      ruleList: markedRuleList,
      ruleListView,
      selectedRuleIds: safeSelectedRuleIds,
      selectedRuleIdMap,
      visibleRuleAllSelected,
      ruleFilters: nextFilters,
      ruleFilterOptions: filterOptions
    });
  },

  filterAdminCandidates(keyword) {
    const text = String(keyword || '').trim().toLowerCase();
    const sourceList = this.data.hrList || [];

    if (!text) {
      return sourceList;
    }

    return sourceList.filter((item) => {
      const fields = [
        item.name,
        item.studentId,
        item.department,
        item.identity,
        item.workGroup
      ].map((value) => String(value || '').toLowerCase());

      return fields.some((value) => value.indexOf(text) !== -1);
    });
  },

  refreshAdminCandidates(keyword = this.data.adminCandidateKeyword) {
    this.setData({
      adminCandidateKeyword: keyword,
      adminCandidateList: this.filterAdminCandidates(keyword)
    });
  },

  async loadActivityList() {
    this.setLoading('activities', true);
    try {
      const result = await this.callCloud('listScoreActivities');
      const currentActivity = (result.list || []).find((item) => item.id === (result.currentActivityId || '')) || {};
      this.setData({
        activityList: result.list || [],
        currentActivityId: result.currentActivityId || '',
        currentActivityName: currentActivity.name || ''
      });
    } catch (error) {
      wx.showToast({
        title: '加载评分活动失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('activities', false);
    }
  },

  async loadTemplateList() {
    this.setLoading('templates', true);
    try {
      const result = await this.callCloud('listScoreTemplates');
      this.setData({
        templateList: result.list || []
      });
    } catch (error) {
      wx.showToast({
        title: '加载评分问题失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('templates', false);
    }
  },

  async loadRuleList(options = {}) {
    const silent = !!options.silent;
    if (!silent) {
      this.setLoading('rules', true);
    }
    try {
      if (!this.data.currentActivityId) {
        this.setRuleListState([], [], emptyRuleFilters());
        return;
      }

      const result = await this.callCloud('listRateRules', {
        activityId: this.data.currentActivityId
      });
      if (result.status && result.status !== 'success') {
        throw new Error(result.message || '加载评分人类别失败');
      }
      this.setRuleListState(result.rules || [], this.data.selectedRuleIds, this.data.ruleFilters);
    } catch (error) {
      if (!silent) {
        wx.showToast({
          title: '加载评分人类别失败',
          icon: 'none'
        });
      }
    } finally {
      if (!silent) {
        this.setLoading('rules', false);
      }
    }
  },

  wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },

  async reloadRuleListWithRetry(expectedMinimum = 0) {
    const retryDelays = [0, 200, 500];
    for (let i = 0; i < retryDelays.length; i += 1) {
      if (retryDelays[i] > 0) {
        await this.wait(retryDelays[i]);
      }

      await this.loadRuleList();
      if ((this.data.ruleList || []).length >= expectedMinimum) {
        return;
      }
    }
  },

  upsertRuleListItem(rule) {
    const item = buildRuleListItem(rule);
    if (!item.id && (!item.scorerDepartment || !item.scorerIdentity)) {
      return;
    }

    const selectedRuleIds = this.data.selectedRuleIds || [];
    const nextList = [...(this.data.ruleList || [])];
    const index = nextList.findIndex((current) => (
      (item.id && String(current.id || '') === item.id)
      || (
        String(current.scorerDepartment || '') === item.scorerDepartment
        && String(current.scorerIdentity || '') === item.scorerIdentity
      )
    ));
    if (index >= 0) {
      nextList[index] = {
        ...nextList[index],
        ...item
      };
    } else {
      nextList.push(item);
    }

    nextList.sort((a, b) => {
      if (a.scorerDepartment !== b.scorerDepartment) {
        return String(a.scorerDepartment || '').localeCompare(String(b.scorerDepartment || ''), 'zh-CN');
      }
      return String(a.scorerIdentity || '').localeCompare(String(b.scorerIdentity || ''), 'zh-CN');
    });

    this.setRuleListState(nextList, selectedRuleIds, this.data.ruleFilters);
  },

  async reloadRuleListAfterSave(savedRule) {
    this.upsertRuleListItem(savedRule);
    const expectedId = String((savedRule && savedRule.id) || '').trim();
    const expectedDepartment = String((savedRule && savedRule.scorerDepartment) || '').trim();
    const expectedIdentity = String((savedRule && savedRule.scorerIdentity) || '').trim();
    const retryDelays = [120, 300, 600];
    for (let i = 0; i < retryDelays.length; i += 1) {
      await this.wait(retryDelays[i]);
      await this.loadRuleList({ silent: true });
      const matched = (this.data.ruleList || []).find((item) => (
        (expectedId && String(item.id || '') === expectedId)
        || (
          String(item.scorerDepartment || '') === expectedDepartment
          && String(item.scorerIdentity || '') === expectedIdentity
        )
      ));
      if (matched && (matched.clauses || []).length) {
        return;
      }
    }
    this.upsertRuleListItem(savedRule);
  },

  async loadHrList() {
    this.setLoading('hr', true);
    try {
      const result = await this.callCloud('listHrInfo');
      const hrList = result.list || [];
      this.setData({ hrList });
      this.refreshAdminCandidates(this.data.adminCandidateKeyword);
    } catch (error) {
      wx.showToast({
        title: '加载人事成员失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('hr', false);
    }
  },

  async loadAdminList() {
    this.setLoading('admins', true);
    try {
      const result = await this.callCloud('listAdmins');
      this.setData({
        adminList: result.list || [],
        canManageAdmins: !!result.canManage
      });
    } catch (error) {
      wx.showToast({
        title: '加载管理员失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('admins', false);
    }
  },

  async loadDepartmentList() {
    this.setLoading('departments', true);
    try {
      const result = await this.callCloud('listDepartments');
      if (result.status !== 'success') {
        throw new Error(result.message || '加载部门列表失败');
      }
      this.setData({
        departmentList: result.departments || []
      });
    } catch (error) {
      console.error('加载部门列表失败:', error);
      // 不再显示错误提示，因为空数据库是正常情况
      this.setData({
        departmentList: []
      });
    } finally {
      this.setLoading('departments', false);
    }
  },

  async loadWorkGroupList() {
    this.setLoading('workGroups', true);
    try {
      const result = await this.callCloud('listWorkGroups');
      if (result.status !== 'success') {
        throw new Error(result.message || '加载工作分工列表失败');
      }
      const workGroups = (result.workGroups || []).map((item) => {
        const department = this.data.departmentList.find(d => (
          d.id === item.departmentId || d.code === item.departmentCode
        ));
        return {
          ...item,
          departmentCode: item.departmentCode || (department ? department.code : ''),
          departmentName: item.departmentName || (department ? department.name : '')
        };
      });
      this.setData({
        workGroupList: workGroups
      });
    } catch (error) {
      console.error('加载工作分工列表失败:', error);
      // 不再显示错误提示，因为空数据库是正常情况
      this.setData({
        workGroupList: []
      });
    } finally {
      this.setLoading('workGroups', false);
    }
  },

  async loadIdentityList() {
    this.setLoading('identities', true);
    try {
      const result = await this.callCloud('listIdentities');
      if (result.status !== 'success') {
        throw new Error(result.message || '加载身份类别列表失败');
      }
      this.setData({
        identityList: result.identities || []
      });
    } catch (error) {
      console.error('加载身份类别列表失败:', error);
      // 不再显示错误提示，因为空数据库是正常情况
      this.setData({
        identityList: []
      });
    } finally {
      this.setLoading('identities', false);
    }
  },

  onDepartmentFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const rawValue = e.detail.value;
    const value = field === 'description' ? rawValue : rawValue.trim();
    this.setData({
      departmentForm: {
        ...this.data.departmentForm,
        [field]: value
      }
    });
  },

  startCreateDepartment() {
    this.setData({
      departmentForm: emptyDepartmentForm(),
      activeTab: 'departments'
    });
  },

  editDepartment(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.departmentList[index];
    if (!item) {
      return;
    }

    this.setData({
      departmentForm: {
        id: item.id,
        name: item.name,
        description: item.description || ''
      },
      activeTab: 'departments'
    });
  },

  async saveDepartment() {
    const form = this.data.departmentForm;
    if (!form.name) {
      wx.showToast({
        title: '请填写部门名称',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveDepartment', true);
    try {
      const result = await this.callCloud('saveDepartment', {
        id: form.id,
        name: form.name,
        description: form.description
      });

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存部门失败',
          icon: 'none'
        });
        return;
      }

      this.setData({ departmentForm: emptyDepartmentForm() });
      await this.loadDepartmentList();
      await this.loadWorkGroupList();
      this.updateHrFormOptions();
      wx.showToast({
        title: '部门信息已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存部门失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveDepartment', false);
    }
  },

  async deleteDepartment(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) {
      return;
    }

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除部门',
        content: '确认删除这个部门吗？',
        confirmText: '确认删除',
        cancelText: '取消',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });

    if (!confirm) {
      return;
    }

    try {
      const result = await this.callCloud('deleteDepartment', { id });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '删除部门失败',
          icon: 'none'
        });
        return;
      }

      await this.loadDepartmentList();
      await this.loadWorkGroupList();
      this.updateHrFormOptions();
      wx.showToast({
        title: '部门已删除',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '删除部门失败',
        icon: 'none'
      });
    }
  },

  onWorkGroupFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const rawValue = e.detail.value;
    const value = field === 'description' ? rawValue : rawValue.trim();
    this.setData({
      workGroupForm: {
        ...this.data.workGroupForm,
        [field]: value
      }
    });
  },

  onWorkGroupDepartmentChange(e) {
    const index = Number(e.detail.value);
    const department = this.data.departmentList[index];
    if (!department) {
      return;
    }

    this.setData({
      workGroupForm: {
        ...this.data.workGroupForm,
        departmentId: department.id,
        departmentCode: department.code,
        departmentName: department.name
      }
    });
  },

  startCreateWorkGroup() {
    this.setData({
      workGroupForm: emptyWorkGroupForm(),
      activeTab: 'workGroups'
    });
  },

  editWorkGroup(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.workGroupList[index];
    if (!item) {
      return;
    }

    this.setData({
      workGroupForm: {
        id: item.id,
        name: item.name,
        departmentId: item.departmentId,
        departmentCode: item.departmentCode,
        departmentName: item.departmentName,
        description: item.description || ''
      },
      activeTab: 'workGroups'
    });
  },

  async saveWorkGroup() {
    const form = this.data.workGroupForm;
    if (!form.name) {
      wx.showToast({
        title: '请填写工作分工名称',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveWorkGroup', true);
    try {
      const result = await this.callCloud('saveWorkGroup', {
        id: form.id,
        name: form.name,
        departmentId: form.departmentId,
        departmentCode: form.departmentCode,
        description: form.description
      });

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存工作分工失败',
          icon: 'none'
        });
        return;
      }

      this.setData({ workGroupForm: emptyWorkGroupForm() });
      await this.loadWorkGroupList();
      this.updateWorkGroupOptions();
      wx.showToast({
        title: '工作分工信息已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存工作分工失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveWorkGroup', false);
    }
  },

  async deleteWorkGroup(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) {
      return;
    }

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除工作分工',
        content: '确认删除这个工作分工吗？',
        confirmText: '确认删除',
        cancelText: '取消',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });

    if (!confirm) {
      return;
    }

    try {
      const result = await this.callCloud('deleteWorkGroup', { id });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '删除工作分工失败',
          icon: 'none'
        });
        return;
      }

      await this.loadWorkGroupList();
      this.updateWorkGroupOptions();
      wx.showToast({
        title: '工作分工已删除',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '删除工作分工失败',
        icon: 'none'
      });
    }
  },

  onIdentityFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const rawValue = e.detail.value;
    const value = field === 'description' ? rawValue : rawValue.trim();
    this.setData({
      identityForm: {
        ...this.data.identityForm,
        [field]: value
      }
    });
  },

  startCreateIdentity() {
    this.setData({
      identityForm: emptyIdentityForm(),
      activeTab: 'identities'
    });
  },

  editIdentity(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.identityList[index];
    if (!item) {
      return;
    }

    this.setData({
      identityForm: {
        id: item.id,
        name: item.name,
        description: item.description || ''
      },
      activeTab: 'identities'
    });
  },

  async saveIdentity() {
    const form = this.data.identityForm;
    if (!form.name) {
      wx.showToast({
        title: '请填写身份类别名称',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveIdentity', true);
    try {
      const result = await this.callCloud('saveIdentity', {
        id: form.id,
        name: form.name,
        description: form.description
      });

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存身份类别失败',
          icon: 'none'
        });
        return;
      }

      this.setData({ identityForm: emptyIdentityForm() });
      await this.loadIdentityList();
      wx.showToast({
        title: '身份类别信息已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存身份类别失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveIdentity', false);
    }
  },

  async deleteIdentity(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) {
      return;
    }

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除身份类别',
        content: '确认删除这个身份类别吗？',
        confirmText: '确认删除',
        cancelText: '取消',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });

    if (!confirm) {
      return;
    }

    try {
      const result = await this.callCloud('deleteIdentity', { id });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '删除身份类别失败',
          icon: 'none'
        });
        return;
      }

      await this.loadIdentityList();
      this.updateHrFormOptions();
      wx.showToast({
        title: '身份类别已删除',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '删除身份类别失败',
        icon: 'none'
      });
    }
  },

  updateHrFormOptions() {
    const departmentOptions = this.data.departmentList.map(item => item.name);
    const identityOptions = this.data.identityList.map(item => item.name);
    
    this.setData({
      departmentOptions,
      identityOptions
    });
    
    this.updateWorkGroupOptions();
  },

  updateWorkGroupOptions() {
    const { departmentId, department } = this.data.hrForm;
    if (!departmentId && !department) {
      this.setData({ workGroupOptions: [] });
      return;
    }

    const departmentObj = this.data.departmentList.find(d => d.id === departmentId || d.name === department);
    if (!departmentObj) {
      this.setData({ workGroupOptions: [] });
      return;
    }

    const workGroupOptions = this.data.workGroupList
      .filter(wg => (
        wg.departmentCode === departmentObj.code || wg.departmentId === departmentObj.id
      ))
      .map(wg => wg.name);

    this.setData({ workGroupOptions });
  },

  onHrDepartmentChange(e) {
    const index = Number(e.detail.value);
    const department = this.data.departmentOptions[index];
    const departmentObj = this.data.departmentList[index] || {};
    
    this.setData({
      hrForm: {
        ...this.data.hrForm,
        departmentId: departmentObj.id || '',
        department,
        workGroupId: '',
        workGroup: ''
      }
    });
    
    this.updateWorkGroupOptions();
  },

  onHrIdentityChange(e) {
    const index = Number(e.detail.value);
    const identity = this.data.identityOptions[index];
    const identityObj = this.data.identityList[index] || {};
    
    this.setData({
      hrForm: {
        ...this.data.hrForm,
        identityId: identityObj.id || '',
        identity
      }
    });
  },

  onHrWorkGroupChange(e) {
    const index = Number(e.detail.value);
    const workGroup = this.data.workGroupOptions[index];
    const departmentObj = this.data.departmentList.find(d => d.id === this.data.hrForm.departmentId || d.name === this.data.hrForm.department) || {};
    const workGroupObj = this.data.workGroupList.filter(wg => wg.departmentId === departmentObj.id || wg.departmentCode === departmentObj.code)[index] || {};
    
    this.setData({
      hrForm: {
        ...this.data.hrForm,
        workGroupId: workGroupObj.id || '',
        workGroup
      }
    });
  },

  async batchMaintainFromHrInfo() {
    this.setLoading('batchMaintain', true);
    try {
      const result = await this.callCloud('batchMaintainFromHrInfo');
      
      if (result.status !== 'success') {
        console.error('批量维护失败:', result.message);
        wx.showToast({
          title: result.message || '批量维护失败',
          icon: 'none'
        });
        return;
      }

      await this.loadDepartmentList();
      await this.loadWorkGroupList();
      await this.loadIdentityList();
      this.updateHrFormOptions();
      
      const stats = result.stats || {};
      const changedCount = ['departmentsCreated', 'identitiesCreated', 'workGroupsCreated']
        .reduce((sum, key) => sum + Number(stats[key] || 0), 0);
      wx.showToast({
        title: changedCount ? `已补齐${changedCount}项` : '组织字典已完整',
        icon: 'success'
      });
    } catch (error) {
      console.error('批量维护失败:', error);
      wx.showToast({
        title: '批量维护失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('batchMaintain', false);
    }
  },
  reloadScoreResults() {
    this.resetCurrentResultRows();
    this.loadScoreResults();
  },
  
  async loadScoreResults() {
    const viewMode = this.data.resultFilters.viewMode || 'overview';
    const loadToken = Date.now();
    this.resultLoadToken = loadToken;
  
    if (!this.data.currentActivityId) {
      this.setLoading('results', false);
      return;
    }
  
    this.setLoading('results', true);
  
    const mergedRows = {
      overviewRows: [],
      calculationRows: [],
      detailRows: [],
      recordRows: [],
      scorerCompletionRows: []
    };
  
    let offset = 0;
    let hasMore = true;
    let latestResult = null;
    let requestCount = 0;
    const maxRequests = 100;
  
    try {
      if (viewMode === 'overview') {
        const result = await this.callCloud('getScoreResults', {
          activityId: this.data.currentActivityId,
          timezone: this.data.systemConfig.timezone,
          dataType: viewMode,
          offset: 0,
          filters: {
            department: this.data.resultFilters.department,
            identity: this.data.resultFilters.identity,
            workGroup: this.data.resultFilters.workGroup
          }
        });

        if (this.resultLoadToken !== loadToken) {
          return;
        }

        if (result.status !== 'success') {
          wx.showToast({
            title: result.message || '加载评分结果失败',
            icon: 'none'
          });
          return;
        }

        const overviewRows = result.overviewRows || [];
        this.setData({
          'scoreResultsRaw.stats': result.stats || {},
          'scoreResultsRaw.overviewRows': overviewRows,
          resultFilterOptions: {
            departments: buildResultFilterOptions((this.data.departmentList || []).map(function (item) { return item.name; })),
            identities: buildResultFilterOptions((this.data.identityList || []).map(function (item) { return item.name; })),
            workGroups: this.buildWorkGroupFilterOptions()
          },
          resultPagination: {
            ...this.data.resultPagination,
            overview: {
              page: 1,
              pageSize: overviewRows.length,
              hasMore: !!(result.pagination && result.pagination.hasMore),
              total: result.pagination ? result.pagination.total || overviewRows.length : overviewRows.length
            }
          }
        });
        this.applyScoreResultFilters();
        return;
      }

      if (viewMode === 'completion') {
        const result = await this.callCloud('getScoreResults', {
          activityId: this.data.currentActivityId,
          timezone: this.data.systemConfig.timezone,
          dataType: viewMode,
          filters: {
            department: this.data.resultFilters.department,
            identity: this.data.resultFilters.identity,
            workGroup: this.data.resultFilters.workGroup
          }
        });

        if (this.resultLoadToken !== loadToken) {
          return;
        }

        if (result.status !== 'success') {
          wx.showToast({
            title: result.message || '加载评分结果失败',
            icon: 'none'
          });
          return;
        }

        this.setData({
          'scoreResultsRaw.stats': result.stats || {},
          'scoreResultsRaw.completionBoards': result.completionBoards || { departments: [] },
          'scoreResultsRaw.scorerCompletionRows': [],
          resultFilterOptions: {
            departments: buildResultFilterOptions((this.data.departmentList || []).map((item) => item.name)),
            identities: buildResultFilterOptions((this.data.identityList || []).map((item) => item.name)),
            workGroups: this.buildWorkGroupFilterOptions()
          }
        });
        this.applyScoreResultFilters();
        return;
      }

      while (hasMore && requestCount < maxRequests) {
        const result = await this.callCloud('getScoreResults', {
          activityId: this.data.currentActivityId,
          timezone: this.data.systemConfig.timezone,
          dataType: viewMode,
          offset,
          filters: {
            department: this.data.resultFilters.department,
            identity: this.data.resultFilters.identity,
            workGroup: this.data.resultFilters.workGroup
          }
        });

        if (this.resultLoadToken !== loadToken) {
          return;
        }

        if (result.status !== 'success') {
          wx.showToast({
            title: result.message || '加载评分结果失败',
            icon: 'none'
          });
          return;
        }

        latestResult = result;

        const batchMap = {
          overview: result.overviewRows || [],
          calculation: result.calculationRows || [],
          detail: result.detailRows || [],
          records: result.recordRows || [],
          completion: result.scorerCompletionRows || []
        };

        const batchRows = batchMap[viewMode] || [];

        if (viewMode === 'overview') {
          mergedRows.overviewRows.push(...batchRows);
        } else if (viewMode === 'calculation') {
          mergedRows.calculationRows.push(...batchRows);
        } else if (viewMode === 'detail') {
          mergedRows.detailRows.push(...batchRows);
        } else if (viewMode === 'records') {
          mergedRows.recordRows.push(...batchRows);
        } else if (viewMode === 'completion') {
          mergedRows.scorerCompletionRows.push(...batchRows);
        }
  
        const setDataObj = {
          'scoreResultsRaw.stats': result.stats || {},
          resultFilterOptions: {
            departments: buildResultFilterOptions((this.data.departmentList || []).map(function (item) { return item.name; })),
            identities: buildResultFilterOptions((this.data.identityList || []).map(function (item) { return item.name; })),
            workGroups: this.buildWorkGroupFilterOptions()
          }
        };
        
        if (viewMode === 'overview') {
          setDataObj['scoreResultsRaw.overviewRows'] = mergedRows.overviewRows;
        }
        
        if (viewMode === 'calculation') {
          setDataObj['scoreResultsRaw.calculationRows'] = mergedRows.calculationRows;
        }
        
        if (viewMode === 'detail') {
          setDataObj['scoreResultsRaw.detailRows'] = mergedRows.detailRows;
        }
        
        if (viewMode === 'records') {
          setDataObj['scoreResultsRaw.recordRows'] = mergedRows.recordRows;
        }
        
        if (viewMode === 'completion') {
          setDataObj['scoreResultsRaw.scorerCompletionRows'] = mergedRows.scorerCompletionRows;
          setDataObj['scoreResultsRaw.completionBoards'] = result.completionBoards || {
            departments: []
          };
        }
        
        this.setData(setDataObj);
  
        this.applyScoreResultFilters();
  
        hasMore = !!(result.pagination && result.pagination.hasMore);
        const nextOffset = result.pagination ? Number(result.pagination.nextOffset || 0) : 0;

        if (!batchRows.length || nextOffset <= offset) {
          hasMore = false;
        } else {
          offset = nextOffset;
        }
  
        requestCount += 1;
      }
  
      this.setData({
        resultPagination: {
          ...this.data.resultPagination,
          [viewMode]: {
            page: 1,
            pageSize: latestResult && latestResult.pagination ? latestResult.pagination.returnedCount || 0 : 0,
            hasMore: false,
            total: latestResult && latestResult.pagination ? latestResult.pagination.total || 0 : 0
          }
        }
      });
    } catch (error) {
      console.error('加载评分结果失败：', error);
      wx.showToast({
        title: getErrorText(error, '加载评分结果失败'),
        icon: 'none'
      });
    } finally {
      if (this.resultLoadToken === loadToken) {
        this.setLoading('results', false);
      }
    }
  },
  
  loadMoreScoreResults() {
    // 已改成自动连续请求，不再依赖滚动触底加载
  },

  async openTargetScoreRecords(e) {
    const targetId = String(e.currentTarget.dataset.targetId || '').trim();
    const target = (this.data.scoreResultsView.overviewRows || []).find((item) => String(item.targetId || item.id) === targetId);
    if (!target || !this.data.currentActivityId) {
      return;
    }

    await this.loadTargetScoreRecords(targetId, target);
  },

  async loadTargetScoreRecords(targetId, target, options = {}) {
    const requestToken = `${targetId}_${Date.now()}`;
    this.targetRecordLoadToken = requestToken;
    const revokedRecordId = String(options.revokedRecordId || '').trim();
    const keepRows = options.keepRows === true;

    const loadingData = {
      selectedResultTarget: target,
      targetRecordLoading: true
    };
    if (!keepRows) {
      loadingData.targetRecordRows = [];
    }
    this.setData(loadingData);

    try {
      const result = await this.callCloud('getScoreResults', {
        activityId: this.data.currentActivityId,
        timezone: this.data.systemConfig.timezone,
        dataType: 'targetRecords',
        targetId
      });

      const currentTargetId = String((this.data.selectedResultTarget && (this.data.selectedResultTarget.targetId || this.data.selectedResultTarget.id)) || '');
      if (this.targetRecordLoadToken !== requestToken || currentTargetId !== targetId) {
        return;
      }

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '加载评分记录失败',
          icon: 'none'
        });
        return;
      }

      const targetRows = (result.targetRecordRows || []).map((item) => {
        const forcePending = revokedRecordId && String(item.recordId || '') === revokedRecordId;
        const normalizedItem = forcePending ? {
          ...item,
          recordId: '',
          status: 'pending',
          statusText: '未完成',
          submittedAt: '',
          excludedByRequireAll: false
        } : item;
        const recordStatus = normalizedItem.status === 'inactive' || normalizedItem.excludedByRequireAll
          ? 'inactive'
          : normalizedItem.status;
        return {
          ...normalizedItem,
          status: recordStatus,
          canViewDetail: (recordStatus === 'completed' || recordStatus === 'inactive') && !!normalizedItem.recordId,
          departmentText: normalizedItem.scorerDepartment || '未设置部门',
          identityText: normalizedItem.scorerIdentity || '未设置身份',
          workGroupText: normalizedItem.scorerWorkGroup || normalizedItem.workGroup || '',
          statusClass: recordStatus === 'completed'
            ? 'status-completed'
            : (recordStatus === 'inactive' ? 'status-inactive' : 'status-pending'),
          scoreTagClass: recordStatus === 'completed'
            ? 'score-tag-completed'
            : (recordStatus === 'inactive' ? 'score-tag-inactive' : 'score-tag-pending')
        };
      });

      this.setData({
        targetRecordRows: targetRows
      });
    } catch (error) {
      if (this.targetRecordLoadToken !== requestToken) {
        return;
      }
      wx.showToast({
        title: '加载评分记录失败',
        icon: 'none'
      });
    } finally {
      if (this.targetRecordLoadToken === requestToken) {
        this.setData({
          targetRecordLoading: false
        });
      }
    }
  },

  closeTargetScoreRecords() {
    this.targetRecordLoadToken = '';
    this.setData({
      selectedResultTarget: null,
      targetRecordRows: []
    });
  },

  async openScoreRecordDetail(e) {
    const recordId = String(e.currentTarget.dataset.recordId || '').trim();
    if (!recordId || !this.data.currentActivityId) {
      return;
    }

    this.setData({
      recordDetailPopupVisible: true,
      recordDetail: null
    });
    this.setLoading(`recordDetail_${recordId}`, true);
    try {
      const result = await this.callCloud('getScoreResults', {
        activityId: this.data.currentActivityId,
        timezone: this.data.systemConfig.timezone,
        dataType: 'recordDetail',
        recordId
      });

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '加载评分详情失败',
          icon: 'none'
        });
        this.setData({ recordDetailPopupVisible: false });
        return;
      }

      const recordDetail = result.recordDetail ? {
        ...result.recordDetail,
        templates: (result.recordDetail.templates || []).map((template) => ({
          ...template,
          questions: (template.questions || []).map((question) => ({
            ...question,
            expandKey: `${template.templateId}_${question.questionIndex}`,
            hasScoreLabel: !!question.scoreLabel,
            scoreLabelExpanded: false
          }))
        }))
      } : null;

      this.setData({
        recordDetail,
        expandedScoreLabelMap: {}
      });
    } catch (error) {
      this.setData({ recordDetailPopupVisible: false });
      wx.showToast({
        title: '加载评分详情失败',
        icon: 'none'
      });
    } finally {
      this.setLoading(`recordDetail_${recordId}`, false);
    }
  },

  closeScoreRecordDetail() {
    this.setData({
      recordDetailPopupVisible: false,
      recordDetail: null,
      expandedScoreLabelMap: {}
    });
  },

  toggleScoreLabel(e) {
    const templateIndex = Number(e.currentTarget.dataset.templateIndex);
    const questionIndex = Number(e.currentTarget.dataset.questionIndex);
    const recordDetail = this.data.recordDetail;
    if (!recordDetail || !recordDetail.templates || !recordDetail.templates[templateIndex]) {
      return;
    }

    const templates = recordDetail.templates.map((template, currentTemplateIndex) => {
      if (currentTemplateIndex !== templateIndex) {
        return template;
      }
      return {
        ...template,
        questions: (template.questions || []).map((question, currentQuestionIndex) => {
          if (currentQuestionIndex !== questionIndex) {
            return question;
          }
          return {
            ...question,
            scoreLabelExpanded: !question.scoreLabelExpanded
          };
        })
      };
    });

    this.setData({
      recordDetail: {
        ...recordDetail,
        templates
      }
    });
  },
  
  resetCurrentResultRows() {
    const viewMode = this.data.resultFilters.viewMode || 'overview';
  
    const nextRaw = {
      ...this.data.scoreResultsRaw
    };
  
    if (viewMode === 'overview') {
      nextRaw.overviewRows = [];
    } else if (viewMode === 'calculation') {
      nextRaw.calculationRows = [];
    } else if (viewMode === 'detail') {
      nextRaw.detailRows = [];
    } else if (viewMode === 'records') {
      nextRaw.recordRows = [];
    } else if (viewMode === 'completion') {
      nextRaw.scorerCompletionRows = [];
      nextRaw.completionBoards = {
        departments: [],
        identities: [],
        workGroups: []
      };
    }
  
    this.setData({
      scoreResultsRaw: nextRaw,
      selectedResultTarget: null,
      targetRecordRows: [],
      recordDetailPopupVisible: false,
      recordDetail: null,
      expandedScoreLabelMap: {},
      selectedCompletionDepartment: '',
      departmentScorerRows: [],
      departmentScorerLoading: false,
      scorerTargetPopupVisible: false,
      scorerTargetPopupTitle: '',
      scorerTargetPopupLoading: false,
      scorerTargetPopupRows: [],
      resultPagination: {
        ...this.data.resultPagination,
        [viewMode]: {
          page: 0,
          pageSize: 0,
          hasMore: true,
          total: 0
        }
      }
    });
  },
  buildWorkGroupFilterOptions(department) {
    var dept = department;
    if (dept === undefined) {
      dept = this.data.resultFilters.department;
    }
    var workGroupList = this.data.workGroupList || [];
    if (!dept || dept === '全部') {
      return ['全部'];
    }
    var deptId = '';
    var deptList = this.data.departmentList || [];
    for (var i = 0; i < deptList.length; i++) {
      if (deptList[i].name === dept) {
        deptId = deptList[i].id || deptList[i]._id || '';
        break;
      }
    }
    var filtered = workGroupList
      .filter(function (item) {
        return item.departmentId === deptId || item.departmentName === dept;
      })
      .map(function (item) { return item.name; });
    return ['全部'].concat(filtered);
  },

  applyScoreResultFilters() {
    const filters = this.data.resultFilters || emptyResultFilters();
    const isAllValue = (value) => !value
      || value === '全部'
      || value === '全部部门'
      || value === '全部身份'
      || value === '全部工作分工'
      || value === '全部工作分工（职能组）'
      || value === '全部状态';
    const matches = (row) => {
      if (!isAllValue(filters.department) && row.department !== filters.department) {
        return false;
      }
      if (!isAllValue(filters.identity) && row.identity !== filters.identity) {
        return false;
      }
      if (!isAllValue(filters.workGroup) && (row.workGroup || '') !== filters.workGroup) {
        return false;
      }
      return true;
    };

    const sortRows = (rows, scoreField = 'finalScore') => {
      const nextRows = [...rows];
      const sortMode = filters.sortMode;
      nextRows.sort((a, b) => {
        if (sortMode === 'name_asc') {
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
        }
        if (sortMode === 'department_asc') {
          const depCompare = String(a.department || '').localeCompare(String(b.department || ''), 'zh-CN');
          return depCompare || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
        }
        if (sortMode === 'workGroup_asc') {
          const groupCompare = String(a.workGroup || '').localeCompare(String(b.workGroup || ''), 'zh-CN');
          return groupCompare || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
        }
        return Number(b[scoreField] || 0) - Number(a[scoreField] || 0);
      });
      return nextRows;
    };

    const overviewRows = sortRows((this.data.scoreResultsRaw.overviewRows || []).filter(matches), 'finalScore').map((row) => {
      const expected = Math.max(0, Math.floor(toNumber(row.expectedScorerCount, 0)));
      const submitted = Math.max(0, Math.floor(toNumber(row.submittedScorerCount, 0)));
      const safeSubmitted = expected ? Math.min(expected, submitted) : submitted;
      const rate = expected ? (safeSubmitted / expected) * 100 : 100;
      const percent = clampNumber(rate, 0, 100);
      return {
        ...row,
        finalScoreDisplay: formatScoreFixed3(row.finalScore),
        progressText: `${safeSubmitted}/${expected}`,
        progressPercentText: `${Math.round(percent)}%`,
        progressFillStyle: buildProgressFillStyle(percent)
      };
    });
    const calculationRows = sortRows((this.data.scoreResultsRaw.calculationRows || []).filter(matches), 'contributionScore');
    const detailRows = sortRows((this.data.scoreResultsRaw.detailRows || []).filter(matches), 'weightedScore');
    const recordRows = sortRows((this.data.scoreResultsRaw.recordRows || []).filter(matches), 'submittedAt');
    const backendBoards = (this.data.scoreResultsRaw.completionBoards || {}).departments || [];
    const completionBoards = backendBoards.map((item) => {
      const percent = item.memberCount
        ? clampNumber((item.completedCount / item.memberCount) * 100, 0, 100)
        : 100;
      return {
        ...item,
        completionRate: Number(percent.toFixed(2)),
        completionText: `${item.completedCount}/${item.memberCount}`,
        progressPercentText: `${Math.round(percent)}%`,
        progressFillStyle: buildProgressFillStyle(percent),
        scorerRows: undefined
      };
    }).sort((a, b) => {
      const rateDiff = Number(b.completionRate || 0) - Number(a.completionRate || 0);
      if (rateDiff !== 0) return rateDiff;
      return String(a.groupName || '').localeCompare(String(b.groupName || ''), 'zh-CN');
    });

    this.setData({
      scoreResultsView: {
        overviewRows,
        calculationRows,
        detailRows,
        recordRows,
        scorerCompletionRows: [],
        completionBoards: {
          departments: completionBoards
        }
      }
    });
  },

  async toggleDepartmentScorers(e) {
    const { groupName } = e.currentTarget.dataset;
    if (!groupName || !this.data.currentActivityId) return;

    if (this.data.selectedCompletionDepartment === groupName) {
      this.closeDepartmentScorers();
      return;
    }

    const loadToken = Date.now();
    this.departmentScorerToken = loadToken;

    this.setData({
      selectedCompletionDepartment: groupName,
      departmentScorerLoading: true,
      departmentScorerRows: []
    });

    try {
      const result = await this.callCloud('getScoreResults', {
        activityId: this.data.currentActivityId,
        timezone: this.data.systemConfig.timezone,
        dataType: 'completion',
        departmentName: groupName,
        filters: {
          department: this.data.resultFilters.department,
          identity: this.data.resultFilters.identity,
          workGroup: this.data.resultFilters.workGroup
        }
      });

      if (this.departmentScorerToken !== loadToken) return;

      if (result.status !== 'success') {
        wx.showToast({ title: result.message || '加载失败', icon: 'none' });
        this.setData({ departmentScorerLoading: false });
        return;
      }

      const rows = (result.scorerCompletionRows || []).map((item) => {
        const expectedCount = Math.max(0, Math.floor(toNumber(item.expectedCount, 0)));
        const submittedCount = Math.max(0, Math.floor(toNumber(item.submittedCount, 0)));
        const pendingCount = Math.max(expectedCount - submittedCount, 0);
        return {
          ...item,
          expectedCount,
          submittedCount,
          pendingCount,
          detailText: [item.identity, item.workGroup].filter(Boolean).join(' / ') || '未设置',
          completionText: `${submittedCount}/${expectedCount}`,
          progressPercentText: `${expectedCount ? Math.round((submittedCount / expectedCount) * 100) : 100}%`,
          progressFillStyle: buildProgressFillStyle(expectedCount ? (submittedCount / expectedCount) * 100 : 100),
          statusText: pendingCount > 0 ? '未完成' : '已完成',
          statusClass: pendingCount > 0 ? 'status-pending' : 'status-completed'
        };
      });

      this.setData({
        departmentScorerRows: rows,
        departmentScorerLoading: false
      });
    } catch (error) {
      if (this.departmentScorerToken !== loadToken) return;
      wx.showToast({ title: '加载评分人列表失败', icon: 'none' });
      this.setData({ departmentScorerLoading: false });
    }
  },

  closeDepartmentScorers() {
    this.departmentScorerToken = '';
    this.setData({
      selectedCompletionDepartment: '',
      departmentScorerLoading: false,
      departmentScorerRows: []
    });
  },

  async openScorerTargetPopup(e) {
    const { scorerKey } = e.currentTarget.dataset;
    if (!scorerKey || !this.data.currentActivityId) return;

    const popupToken = Date.now();
    this.scorerTargetPopupToken = popupToken;

    const scorerRow = (this.data.departmentScorerRows || []).find((item) => item.scorerKey === scorerKey);
    const scorerName = scorerRow ? scorerRow.scorerName : scorerKey;

    this.setData({
      scorerTargetPopupVisible: true,
      scorerTargetPopupTitle: `${scorerName} 的被评分人完成情况`,
      scorerTargetPopupLoading: true,
      scorerTargetPopupRows: []
    });

    try {
      const result = await this.callCloud('getScoreResults', {
        activityId: this.data.currentActivityId,
        timezone: this.data.systemConfig.timezone,
        dataType: 'scorerTargets',
        scorerKey
      });

      if (this.scorerTargetPopupToken !== popupToken) return;

      if (result.status !== 'success') {
        wx.showToast({ title: result.message || '加载失败', icon: 'none' });
        this.setData({ scorerTargetPopupLoading: false });
        return;
      }

      const rows = (result.scorerTargetRows || []).map((item) => ({
        ...item,
        detailText: [item.targetDepartment, item.targetIdentity, item.targetWorkGroup].filter(Boolean).join(' / ') || '未设置'
      }));

      this.setData({
        scorerTargetPopupRows: rows,
        scorerTargetPopupLoading: false
      });
    } catch (error) {
      if (this.scorerTargetPopupToken !== popupToken) return;
      wx.showToast({ title: '加载被评分人列表失败', icon: 'none' });
      this.setData({ scorerTargetPopupLoading: false });
    }
  },

  closeScorerTargetPopup() {
    this.scorerTargetPopupToken = '';
    this.setData({
      scorerTargetPopupVisible: false,
      scorerTargetPopupTitle: '',
      scorerTargetPopupLoading: false,
      scorerTargetPopupRows: []
    });
  },

  openScorerTargetRecordDetail(e) {
    const recordId = String(e.currentTarget.dataset.recordId || '').trim();
    if (!recordId) return;
    this.openScoreRecordDetail(e);
  },

  noop() {},

  onResultFilterChange(e) {
    const { field } = e.currentTarget.dataset;
    const { value } = e.detail;
    const optionsMap = {
      department: this.data.resultFilterOptions.departments,
      identity: this.data.resultFilterOptions.identities,
      workGroup: this.data.resultFilterOptions.workGroups,
      viewMode: (this.data.resultViewOptions || []).map((item) => item.label),
      sortMode: (this.data.resultSortOptions || []).map((item) => item.label)
    };
    const rawOptions = optionsMap[field] || [];
    const pickedLabel = rawOptions[Number(value)] || '全部';

    let nextValue = pickedLabel;
    if (field === 'viewMode') {
      nextValue = (this.data.resultViewOptions[Number(value)] || {}).value || 'overview';
      this.setData({
        resultViewLabel: (this.data.resultViewOptions[Number(value)] || {}).label || '明细查看'
      });
    }
    if (field === 'sortMode') {
      nextValue = (this.data.resultSortOptions[Number(value)] || {}).value || 'score_desc';
      this.setData({
        resultSortLabel: (this.data.resultSortOptions[Number(value)] || {}).label || '按分数从高到低'
      });
    }

    const nextFilters = {
      ...this.data.resultFilters,
      [field]: nextValue
    };

    if (field === 'department') {
      nextFilters.workGroup = '全部';
    }

    this.setData({
      resultFilters: nextFilters,
      'resultFilterOptions.workGroups': this.buildWorkGroupFilterOptions(nextFilters.department)
    });
    this.resetCurrentResultRows();
    this.loadScoreResults({ append: false });
  },

  async exportScoreResults(e) {
    const { report, format } = e.currentTarget.dataset;
    if (!this.data.currentActivityId) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    this.setLoading(`export_${report}_${format}`, true);
    try {
      const result = await this.callCloud('exportScoreResults', {
        activityId: this.data.currentActivityId,
        timezone: this.data.systemConfig.timezone,
        reportType: report,
        format,
        filters: {
          department: this.data.resultFilters.department,
          identity: this.data.resultFilters.identity,
          workGroup: this.data.resultFilters.workGroup
        }
      });

      if (result.status !== 'success' || !result.fileContent || !result.fileName) {
        wx.showToast({
          title: result.message || '导出失败',
          icon: 'none'
        });
        return;
      }

      const extension = result.extension || (format === 'excel' ? 'xls' : 'csv');
      const filePath = `${wx.env.USER_DATA_PATH}/${result.fileName}.${extension}`;
      const fs = wx.getFileSystemManager();
      fs.writeFileSync(filePath, result.fileContent, 'utf8');

      wx.openDocument({
        filePath,
        fileType: extension,
        showMenu: true,
        fail: () => {
          wx.shareFileMessage({
            filePath,
            fileName: `${result.fileName}.${extension}`,
            fail: () => {
              wx.showToast({
                title: '文件已保存到本地',
                icon: 'none'
              });
            }
          });
        }
      });
    } catch (error) {
      wx.showToast({
        title: '导出失败',
        icon: 'none'
      });
    } finally {
      this.setLoading(`export_${report}_${format}`, false);
    }
  },

  async revokeScoreRecord(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) {
      return;
    }

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '撤销评分记录',
        content: '撤销后该条评分记录会被删除，成员将恢复为待评分状态，是否继续？',
        confirmText: '确认撤销',
        cancelText: '取消',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });

    if (!confirm) {
      return;
    }

    this.setLoading(`revoke_${id}`, true);
    try {
      const result = await this.callCloud('revokeScoreRecord', {
        recordId: id
      });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '撤销评分记录失败',
          icon: 'none'
        });
        return;
      }
      wx.showToast({
        title: '评分记录已撤销',
        icon: 'success'
      });
      const selectedTarget = this.data.selectedResultTarget;
      const revokedRow = (this.data.targetRecordRows || []).find((item) => String(item.recordId || '') === String(id));
      this.setData({
        recordDetailPopupVisible: false,
        recordDetail: null,
        expandedScoreLabelMap: {},
        targetRecordRows: (this.data.targetRecordRows || []).map((item) => {
          if (String(item.recordId || '') !== String(id)) {
            return item;
          }
          return {
            ...item,
            recordId: '',
            status: 'pending',
            statusText: '未完成',
            submittedAt: '',
            excludedByRequireAll: false,
            canViewDetail: false,
            statusClass: 'status-pending',
            scoreTagClass: 'score-tag-pending'
          };
        })
      });
      await this.loadScoreResults();
      if (selectedTarget && (selectedTarget.targetId || selectedTarget.id)) {
        const targetId = String(selectedTarget.targetId || selectedTarget.id);
        const latestTarget = (this.data.scoreResultsView.overviewRows || [])
          .find((item) => String(item.targetId || item.id) === targetId) || selectedTarget;
        await this.loadTargetScoreRecords(targetId, latestTarget, {
          revokedRecordId: id,
          revokedScorerKey: revokedRow && revokedRow.scorerKey,
          keepRows: true
        });
      }
    } catch (error) {
      wx.showToast({
        title: '撤销评分记录失败',
        icon: 'none'
      });
    } finally {
      this.setLoading(`revoke_${id}`, false);
    }
  },

  onActivityFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const rawValue = e.detail.value;
    const value = field === 'description' ? rawValue : rawValue.trim();
    this.setData({
      activityForm: {
        ...this.data.activityForm,
        [field]: value
      }
    });
  },

  resetActivityForm() {
    this.setData({
      activityForm: emptyActivityForm()
    });
  },

  editActivity(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.activityList[index];
    if (!item) {
      return;
    }

    this.setData({
      activityForm: {
        id: item.id,
        name: item.name,
        description: item.description || '',
        startDate: item.startDate || '',
        endDate: item.endDate || ''
      },
      activeTab: 'activities'
    });
  },

  startCreateActivity() {
    this.resetActivityForm();
    this.setData({ activeTab: 'activities' });
  },

  async saveActivity() {
    const form = this.data.activityForm;
    if (!form.name) {
      wx.showToast({
        title: '请填写评分活动名称',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveActivity', true);
    try {
      const result = await this.callCloud('saveScoreActivity', form);
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存活动失败',
          icon: 'none'
        });
        return;
      }

      this.resetActivityForm();
      await this.loadActivityList();
      wx.showToast({
        title: '评分活动已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存活动失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveActivity', false);
    }
  },

  setCurrentActivity(e) {
    const { id } = e.currentTarget.dataset;
    if (!id || id === this.data.currentActivityId) {
      return;
    }

    wx.showModal({
      title: '设为当前评分活动',
      content: '确认将这条活动设为当前评分活动吗？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }

        try {
          const result = await this.callCloud('setCurrentScoreActivity', { id });
          if (result.status !== 'success') {
            wx.showToast({
              title: result.message || '设置失败',
              icon: 'none'
            });
            return;
          }

          await this.loadActivityList();
          await this.loadRuleList();
          if (this.data.activeTab === 'results') {
            await this.loadScoreResults();
          }
          wx.showToast({
            title: '当前活动已切换',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '设置当前活动失败',
            icon: 'none'
          });
        }
      }
    });
  },

  deleteActivity(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除评分活动',
      content: '删除后会一并清理该活动下的评分人类别、被评分人规则和评分记录，是否继续？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }

        try {
          const result = await this.callCloud('deleteScoreActivity', { id });
          if (result.status !== 'success') {
            wx.showToast({
              title: result.message || '删除失败',
              icon: 'none'
            });
            return;
          }

          await this.loadActivityList();
          await this.loadRuleList();
          if (this.data.activeTab === 'results') {
            await this.loadScoreResults();
          }
          wx.showToast({
            title: '评分活动已删除',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '删除评分活动失败',
            icon: 'none'
          });
        }
      }
    });
  },

  onTemplateFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const rawValue = e.detail.value;
    const value = field === 'description' ? rawValue : rawValue.trim();
    this.setData({
      templateForm: {
        ...this.data.templateForm,
        [field]: value
      }
    });
  },

  onTemplateQuestionInput(e) {
    const { index, field } = e.currentTarget.dataset;
    const questionIndex = Number(index);
    const questions = [...this.data.templateForm.questions];
    if (!questions[questionIndex]) {
      return;
    }

    const rawValue = e.detail.value;
    const value = field === 'scoreLabel' ? rawValue : rawValue.trim();

    questions[questionIndex] = {
      ...questions[questionIndex],
      [field]: value
    };

    this.setData({
      templateForm: {
        ...this.data.templateForm,
        questions
      }
    });
  },

  addTemplateQuestion() {
    this.setData({
      templateForm: {
        ...this.data.templateForm,
        questions: [...this.data.templateForm.questions, createEmptyQuestion()]
      }
    });
  },

  removeTemplateQuestion(e) {
    const index = Number(e.currentTarget.dataset.index);
    const questions = this.data.templateForm.questions.filter((_, questionIndex) => questionIndex !== index);
    this.setData({
      templateForm: {
        ...this.data.templateForm,
        questions: questions.length ? questions : [createEmptyQuestion()]
      }
    });
  },

  resetTemplateForm() {
    this.setData({
      templateForm: emptyTemplateForm()
    });
  },

  startCreateTemplate() {
    this.resetTemplateForm();
    this.setData({ activeTab: 'templates' });
  },

  async saveTemplate() {
    const form = this.data.templateForm || emptyTemplateForm();
    const name = String(form.name || '').trim();
    const description = String(form.description || '');
    const questions = (form.questions || []).map((question) => ({
      question: String(question.question || '').trim(),
      scoreLabel: String(question.scoreLabel || ''),
      minValue: String(question.minValue == null ? '0' : question.minValue).trim(),
      startValue: String(
        question.startValue == null || question.startValue === ''
          ? '0'
          : question.startValue
      ).trim(),
      maxValue: String(question.maxValue == null ? '' : question.maxValue).trim(),
      stepValue: String(
        question.stepValue == null || question.stepValue === ''
          ? '0.5'
          : question.stepValue
      ).trim()
    })).filter((question) => question.question);

    if (!name) {
      wx.showToast({
        title: '请填写评分问题名称',
        icon: 'none'
      });
      return;
    }

    if (!questions.length) {
      wx.showToast({
        title: '请至少填写一道题目',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveTemplate', true);
    try {
      const result = await this.callCloud('saveScoreTemplate', {
        id: form.id,
        name,
        description,
        questions
      });

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存评分问题失败',
          icon: 'none'
        });
        return;
      }

      this.resetTemplateForm();
      await this.loadTemplateList();
      wx.showToast({
        title: '评分问题已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存评分问题失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveTemplate', false);
    }
  },

  editTemplate(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.templateList[index];
    if (!item) {
      return;
    }

    const questions = (item.questions || []).length
      ? (item.questions || []).map((question) => normalizeTemplateQuestionForForm(question))
      : [createEmptyQuestion()];

    this.setData({
      templateForm: {
        id: item.id,
        name: item.name,
        description: item.description || '',
        questions
      },
      activeTab: 'templates'
    });
  },

  async duplicateTemplate(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) {
      return;
    }

    this.setLoading('duplicateTemplate', true);
    try {
      const result = await this.callCloud('duplicateScoreTemplate', { id });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '复制评分问题失败',
          icon: 'none'
        });
        return;
      }

      await this.loadTemplateList();
      wx.showToast({
        title: '评分问题副本已创建',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '复制评分问题失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('duplicateTemplate', false);
    }
  },

  startClauseTemplateDrag(e) {
    const index = Number(e.currentTarget.dataset.index);
    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!touch || Number.isNaN(index)) {
      return;
    }

    this.clauseTemplateDragState = {
      currentIndex: index,
      lastY: touch.pageY
    };

    this.setData({
      draggingClauseTemplateIndex: index
    });
  },

  onClauseTemplateDragMove(e) {
    if (!this.clauseTemplateDragState || this.data.draggingClauseTemplateIndex < 0) {
      return;
    }

    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!touch) {
      return;
    }

    const deltaY = touch.pageY - this.clauseTemplateDragState.lastY;
    const threshold = 56;
    if (Math.abs(deltaY) < threshold) {
      return;
    }

    const direction = deltaY > 0 ? 1 : -1;
    const fromIndex = this.clauseTemplateDragState.currentIndex;
    const toIndex = fromIndex + direction;

    if (toIndex < 0 || toIndex >= this.data.ruleForm.clauseTemplateConfigs.length) {
      this.clauseTemplateDragState.lastY = touch.pageY;
      return;
    }

    const clauseTemplateConfigs = refreshTemplateConfigSortOrder(moveItem(this.data.ruleForm.clauseTemplateConfigs, fromIndex, toIndex));

    this.clauseTemplateDragState = {
      currentIndex: toIndex,
      lastY: touch.pageY
    };

    this.setData({
      draggingClauseTemplateIndex: toIndex,
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateConfigs
      }
    });
  },

  endClauseTemplateDrag() {
    if (!this.clauseTemplateDragState) {
      return;
    }

    this.clauseTemplateDragState = null;
    this.setData({
      draggingClauseTemplateIndex: -1,
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateConfigs: refreshTemplateConfigSortOrder(this.data.ruleForm.clauseTemplateConfigs)
      }
    });
  },

  onClauseTemplateDragCancel() {
    this.endClauseTemplateDrag();
  },

  deleteTemplate(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除评分问题',
      content: '确认删除这份评分问题吗？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }

        try {
          const result = await this.callCloud('deleteScoreTemplate', { id });
          if (result.status !== 'success') {
            wx.showToast({
              title: result.message || '删除失败',
              icon: 'none'
            });
            return;
          }

          await this.loadTemplateList();
          wx.showToast({
            title: '评分问题已删除',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '删除评分问题失败',
            icon: 'none'
          });
        }
      }
    });
  },

  onRuleFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value.trim();
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        [field]: value
      }
    });
  },

  onClauseScopeChange(e) {
    const clauseScope = RULE_SCOPE_OPTIONS[e.detail.value].value;
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseScope,
        clauseScopeLabel: RULE_SCOPE_OPTIONS[e.detail.value].label
      }
    });
  },

  openScorerTaskPage() {
    if (!this.data.currentActivityId) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/scorerTasks/scorerTasks?activityId=${encodeURIComponent(this.data.currentActivityId)}&activityName=${encodeURIComponent(this.data.currentActivityName || '')}`
    });
  },

  onClauseRequireAllCompleteChange(e) {
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseRequireAllComplete: !!e.detail.value
      }
    });
  },

  openNewRuleClauseEditor() {
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseScope: RULE_SCOPE_OPTIONS[0].value,
        clauseScopeLabel: RULE_SCOPE_OPTIONS[0].label,
        clauseTargetIdentityId: '',
        clauseTargetIdentity: '',
        clauseRequireAllComplete: false,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseEditingIndex: -1,
        clauseTemplateConfigs: [],
        isRuleClauseEditorVisible: true,
        isTemplateConfigEditorVisible: false
      }
    });
  },

  openTemplateConfigEditor() {
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        isTemplateConfigEditorVisible: true
      }
    });
  },

  startCreateRuleCategory() {
    this.setData({
      ruleForm: emptyRuleForm(),
      draggingClauseTemplateIndex: -1
    });
  },

  onRuleScorerDepartmentChange(e) {
    const index = Number(e.detail.value);
    const departmentObj = this.data.departmentList[index] || {};
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        scorerDepartmentId: departmentObj.id || '',
        scorerDepartment: departmentObj.name || ''
      }
    });
  },

  onRuleScorerIdentityChange(e) {
    const index = Number(e.detail.value);
    const identityObj = this.data.identityList[index] || {};
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        scorerIdentityId: identityObj.id || '',
        scorerIdentity: identityObj.name || ''
      }
    });
  },

  onRuleTargetIdentityChange(e) {
    const index = Number(e.detail.value);
    const identityObj = this.data.identityList[index] || {};
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseTargetIdentityId: identityObj.id || '',
        clauseTargetIdentity: identityObj.name || ''
      }
    });
  },

  onRuleFilterChange(e) {
    const { field } = e.currentTarget.dataset;
    const optionKey = field === 'identity' ? 'identities' : 'departments';
    const options = (this.data.ruleFilterOptions || {})[optionKey] || ['全部'];
    const value = options[Number(e.detail.value)] || '全部';
    const nextFilters = {
      ...(this.data.ruleFilters || emptyRuleFilters()),
      [field]: value
    };
    this.setRuleListState(this.data.ruleList, this.data.selectedRuleIds, nextFilters);
  },

  resetRuleFilters() {
    this.setRuleListState(this.data.ruleList, this.data.selectedRuleIds, emptyRuleFilters());
  },

  toggleRuleSelection(e) {
    const { id } = e.currentTarget.dataset;
    const targetId = String(id || '').trim();
    if (!targetId) {
      return;
    }

    const selectedRuleIds = new Set((this.data.selectedRuleIds || []).map((item) => String(item)));
    if (selectedRuleIds.has(targetId)) {
      selectedRuleIds.delete(targetId);
    } else {
      selectedRuleIds.add(targetId);
    }

    const nextSelectedRuleIds = [...selectedRuleIds];
    this.setRuleListState(this.data.ruleList, nextSelectedRuleIds, this.data.ruleFilters);
  },

  toggleSelectAllRules() {
    const visibleRuleIds = (this.data.ruleListView || []).map((item) => item.id).filter(Boolean);
    if (!visibleRuleIds.length) {
      return;
    }

    const selectedSet = new Set((this.data.selectedRuleIds || []).map((item) => String(item)));
    const isVisibleAllSelected = visibleRuleIds.every((id) => selectedSet.has(String(id)));
    visibleRuleIds.forEach((id) => {
      if (isVisibleAllSelected) {
        selectedSet.delete(String(id));
      } else {
        selectedSet.add(String(id));
      }
    });
    this.setRuleListState(this.data.ruleList, [...selectedSet], this.data.ruleFilters);
  },

  reverseSelectVisibleRules() {
    const visibleRuleIds = (this.data.ruleListView || []).map((item) => item.id).filter(Boolean);
    if (!visibleRuleIds.length) {
      return;
    }

    const selectedSet = new Set((this.data.selectedRuleIds || []).map((item) => String(item)));
    visibleRuleIds.forEach((id) => {
      const textId = String(id);
      if (selectedSet.has(textId)) {
        selectedSet.delete(textId);
      } else {
        selectedSet.add(textId);
      }
    });
    this.setRuleListState(this.data.ruleList, [...selectedSet], this.data.ruleFilters);
  },

  async applyClausesToSelectedRules() {
    const selectedRules = (this.data.ruleList || []).filter((item) => (this.data.selectedRuleIds || []).includes(item.id));
    const clauseResult = buildRuleClausesForBatchApply(this.data.ruleForm);
    const clauses = clauseResult.clauses || [];
    const currentActivity = (this.data.activityList || []).find((item) => item.id === this.data.currentActivityId);

    if (!this.data.currentActivityId || !currentActivity) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    if (!selectedRules.length) {
      wx.showToast({
        title: '请先勾选需要批量设置的评分人类别',
        icon: 'none'
      });
      return;
    }

    if (!clauseResult.ok) {
      wx.showToast({
        title: clauseResult.message || '请先准备好要批量应用的被评分人规则',
        icon: 'none'
      });
      return;
    }

    this.setLoading('batchSaveRules', true);
    wx.showLoading({ title: '正在批量应用...', mask: true });
    try {
      const savedRules = [];
      for (const rule of selectedRules) {
        const result = await this.callCloud('saveRateRule', {
          id: rule.id,
          activityId: this.data.currentActivityId,
          activityName: currentActivity.name || '',
          scorerDepartmentId: rule.scorerDepartmentId,
          scorerIdentityId: rule.scorerIdentityId,
          clauses,
          mode: 'replace'
        });

        if (result.status !== 'success') {
          wx.hideLoading();
          wx.showToast({
            title: result.message || (`批量设置失败：${rule.scorerDepartment}/${rule.scorerIdentity}`),
            icon: 'none'
          });
          this.setLoading('batchSaveRules', false);
          return;
        }
        savedRules.push({
          id: result.id || rule.id,
          activityId: this.data.currentActivityId,
          activityName: currentActivity.name || '',
          scorerDepartmentId: rule.scorerDepartmentId,
          scorerDepartment: rule.scorerDepartment,
          scorerIdentityId: rule.scorerIdentityId,
          scorerIdentity: rule.scorerIdentity,
          clauses
        });
      }

      savedRules.forEach((rule) => this.upsertRuleListItem(rule));
      await this.loadRuleList({ silent: true });
      wx.hideLoading();
      wx.showToast({
        title: '批量更新完成',
        icon: 'success'
      });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({
        title: '批量设置规则失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('batchSaveRules', false);
    }
  },

  onRuleTemplateChange(e) {
    const index = Number(e.detail.value);
    const template = this.data.templateList[index];
    if (!template) {
      return;
    }

    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateId: template.id,
        clauseTemplateName: template.name
      }
    });
  },

  addClauseTemplateConfig() {
  const {
    clauseTemplateId,
    clauseTemplateName,
    clauseTemplateWeight,
    clauseTemplateConfigEditingIndex,
    clauseTemplateConfigs
  } = this.data.ruleForm;

    if (!clauseTemplateId) {
      wx.showToast({
        title: '请先选择评分问题',
        icon: 'none'
      });
      return;
    }

    const weight = Number(clauseTemplateWeight);
    if (!Number.isFinite(weight) || weight <= 0) {
      wx.showToast({
        title: '评分问题权重必须大于 0',
        icon: 'none'
      });
      return;
    }

    const sortOrderValue = clauseTemplateConfigEditingIndex >= 0 && clauseTemplateConfigs[clauseTemplateConfigEditingIndex]
      ? Number(clauseTemplateConfigs[clauseTemplateConfigEditingIndex].sortOrder) || (clauseTemplateConfigEditingIndex + 1)
      : clauseTemplateConfigs.length + 1;

    const nextConfig = {
      templateId: clauseTemplateId,
      templateName: clauseTemplateName,
      weight: String(weight),
      sortOrder: String(sortOrderValue)
    };

    const exists = clauseTemplateConfigs.some((item, index) => (
      index !== clauseTemplateConfigEditingIndex &&
      item.templateId === nextConfig.templateId
    ));

    if (exists) {
      wx.showToast({
        title: '这个评分问题已在当前规则中',
        icon: 'none'
      });
      return;
    }

    const nextConfigs = [...clauseTemplateConfigs];
    if (clauseTemplateConfigEditingIndex >= 0 && nextConfigs[clauseTemplateConfigEditingIndex]) {
      nextConfigs[clauseTemplateConfigEditingIndex] = nextConfig;
    } else {
      nextConfigs.push(nextConfig);
    }

    nextConfigs.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
    const normalizedNextConfigs = refreshTemplateConfigSortOrder(nextConfigs);

    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateConfigs: normalizedNextConfigs,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        isTemplateConfigEditorVisible: false
      }
    });
  },

  editClauseTemplateConfig(e) {
    const index = Number(e.currentTarget.dataset.index);
    const targetConfig = this.data.ruleForm.clauseTemplateConfigs[index];
    if (!targetConfig) {
      return;
    }

    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateId: targetConfig.templateId || '',
        clauseTemplateName: targetConfig.templateName || '',
        clauseTemplateWeight: String(targetConfig.weight || '1'),
        clauseTemplateOrder: String(targetConfig.sortOrder || ''),
        clauseTemplateConfigEditingIndex: index,
        isTemplateConfigEditorVisible: true
      }
    });
  },

  removeClauseTemplateConfig(e) {
    const index = Number(e.currentTarget.dataset.index);
    const nextConfigs = this.data.ruleForm.clauseTemplateConfigs.filter((_, configIndex) => configIndex !== index);
    const nextEditingIndex = this.data.ruleForm.clauseTemplateConfigEditingIndex === index
      ? -1
      : (this.data.ruleForm.clauseTemplateConfigEditingIndex > index
        ? this.data.ruleForm.clauseTemplateConfigEditingIndex - 1
        : this.data.ruleForm.clauseTemplateConfigEditingIndex);

    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateConfigs: refreshTemplateConfigSortOrder(nextConfigs),
        clauseTemplateConfigEditingIndex: nextEditingIndex,
      }
    });
  },

  cancelClauseTemplateConfigEdit() {
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        isTemplateConfigEditorVisible: false
      }
    });
  },

  addRuleClause() {
    const {
      clauseScope,
      clauseTargetIdentityId,
      clauseTargetIdentity,
      clauseRequireAllComplete,
      clauseEditingIndex,
      clauseTemplateConfigs,
      clauses
    } = this.data.ruleForm;
    if (clauseScope !== 'all_people' && !clauseTargetIdentityId && clauseScope.indexOf('_all') === -1) {
      wx.showToast({
        title: '请填写被评分人身份',
        icon: 'none'
      });
      return;
    }

    const nextClause = {
      scopeType: clauseScope,
      scopeLabel: getScopeLabel(clauseScope),
      targetIdentityId: clauseTargetIdentityId,
      targetIdentity: clauseTargetIdentity,
      requireAllComplete: !!clauseRequireAllComplete,
      templateConfigs: [...clauseTemplateConfigs].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder))
    };

    const exists = clauses.some((item, index) => (
      index !== clauseEditingIndex &&
      item.scopeType === nextClause.scopeType &&
      item.targetIdentityId === nextClause.targetIdentityId &&
      JSON.stringify(item.templateConfigs || []) === JSON.stringify(nextClause.templateConfigs)
    ));

    if (exists) {
      wx.showToast({
        title: '被评分人规则已存在',
        icon: 'none'
      });
      return;
    }

    const nextClauses = [...clauses];
    if (clauseEditingIndex >= 0 && nextClauses[clauseEditingIndex]) {
      nextClauses[clauseEditingIndex] = nextClause;
    } else {
      nextClauses.push(nextClause);
    }

    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauses: nextClauses,
        clauseScope: RULE_SCOPE_OPTIONS[0].value,
        clauseScopeLabel: RULE_SCOPE_OPTIONS[0].label,
        clauseTargetIdentityId: '',
        clauseTargetIdentity: '',
        clauseRequireAllComplete: false,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseEditingIndex: -1,
        clauseTemplateConfigs: [],
        isRuleClauseEditorVisible: false,
        isTemplateConfigEditorVisible: false
      }
    });
  },

  removeRuleClause(e) {
    const index = Number(e.currentTarget.dataset.index);
    const nextClauses = this.data.ruleForm.clauses.filter((_, clauseIndex) => clauseIndex !== index);
    const nextEditingIndex = this.data.ruleForm.clauseEditingIndex === index
      ? -1
      : (this.data.ruleForm.clauseEditingIndex > index
        ? this.data.ruleForm.clauseEditingIndex - 1
        : this.data.ruleForm.clauseEditingIndex);

    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauses: nextClauses,
        clauseTemplateConfigs: this.data.ruleForm.clauseEditingIndex === index ? [] : this.data.ruleForm.clauseTemplateConfigs,
        clauseTemplateId: this.data.ruleForm.clauseEditingIndex === index ? '' : this.data.ruleForm.clauseTemplateId,
        clauseTemplateName: this.data.ruleForm.clauseEditingIndex === index ? '' : this.data.ruleForm.clauseTemplateName,
        clauseTemplateWeight: this.data.ruleForm.clauseEditingIndex === index ? '1' : this.data.ruleForm.clauseTemplateWeight,
        clauseTemplateOrder: this.data.ruleForm.clauseEditingIndex === index ? '' : this.data.ruleForm.clauseTemplateOrder,
        clauseTemplateConfigEditingIndex: this.data.ruleForm.clauseEditingIndex === index ? -1 : this.data.ruleForm.clauseTemplateConfigEditingIndex,
        clauseEditingIndex: nextEditingIndex,
        isRuleClauseEditorVisible: nextEditingIndex >= 0,
        isTemplateConfigEditorVisible: this.data.ruleForm.clauseEditingIndex === index ? false : this.data.ruleForm.isTemplateConfigEditorVisible
      }
    });
  },

  editRuleClause(e) {
    const index = Number(e.currentTarget.dataset.index);
    const targetClause = this.data.ruleForm.clauses[index];
    if (!targetClause) {
      return;
    }

    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseScope: targetClause.scopeType || RULE_SCOPE_OPTIONS[0].value,
        clauseScopeLabel: getScopeLabel(targetClause.scopeType),
        clauseTargetIdentityId: targetClause.targetIdentityId || '',
        clauseTargetIdentity: targetClause.targetIdentity || '',
        clauseRequireAllComplete: targetClause.requireAllComplete === true,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseTemplateConfigs: refreshTemplateConfigSortOrder(normalizeClauseForEdit(targetClause).templateConfigs),
        clauseEditingIndex: index,
        isRuleClauseEditorVisible: true,
        isTemplateConfigEditorVisible: false
      }
    });
  },

  cancelRuleClauseEdit() {
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseScope: RULE_SCOPE_OPTIONS[0].value,
        clauseScopeLabel: RULE_SCOPE_OPTIONS[0].label,
        clauseTargetIdentityId: '',
        clauseTargetIdentity: '',
        clauseRequireAllComplete: false,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseTemplateConfigs: [],
        clauseEditingIndex: -1,
        isRuleClauseEditorVisible: false,
        isTemplateConfigEditorVisible: false
      }
    });
  },

  editRule(e) {
    const { id, index } = e.currentTarget.dataset;
    const targetId = String(id || '').trim();
    const target = targetId
      ? (this.data.ruleList || []).find((item) => String(item.id || '') === targetId)
      : this.data.ruleList[Number(index)];
    if (!target) {
      return;
    }

    this.setData({
      ruleForm: {
        id: target.id,
        scorerDepartmentId: target.scorerDepartmentId || '',
        scorerDepartment: target.scorerDepartment || '',
        scorerIdentityId: target.scorerIdentityId || '',
        scorerIdentity: target.scorerIdentity || '',
        clauseScope: RULE_SCOPE_OPTIONS[0].value,
        clauseScopeLabel: RULE_SCOPE_OPTIONS[0].label,
        clauseTargetIdentity: '',
        clauseRequireAllComplete: false,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseEditingIndex: -1,
        isRuleClauseEditorVisible: false,
        isTemplateConfigEditorVisible: false,
        clauseTemplateConfigs: [],
        clauses: (target.clauses || []).map((item) => normalizeClauseForEdit(item))
      },
      activeTab: 'rules'
    });
  },

  async saveRuleCategory() {
    const { id, scorerDepartmentId, scorerDepartment, scorerIdentityId, scorerIdentity } = this.data.ruleForm;
    const clauseResult = buildRuleClausesForSave(this.data.ruleForm);
    const clauses = clauseResult.clauses || [];
    const currentActivity = (this.data.activityList || []).find((item) => item.id === this.data.currentActivityId);
    if (!this.data.currentActivityId || !currentActivity) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    if (!scorerDepartmentId || !scorerIdentityId) {
      wx.showToast({
        title: '请填写完整的评分人类别',
        icon: 'none'
      });
      return;
    }

    if (!clauseResult.ok) {
      wx.showToast({
        title: clauseResult.message || '请先添加被评分人规则',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveRule', true);
    try {
      const result = await this.callCloud('saveRateRule', {
        id,
        activityId: this.data.currentActivityId,
        activityName: currentActivity.name || '',
        scorerDepartmentId,
        scorerIdentityId,
        clauses
      });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存评分人类别失败',
          icon: 'none'
        });
        return;
      }

      await this.reloadRuleListAfterSave(result.rule || {
        id: result.id || id,
        activityId: this.data.currentActivityId,
        activityName: currentActivity.name || '',
        scorerDepartmentId,
        scorerIdentityId,
        clauses
      });
      this.setData({ ruleForm: emptyRuleForm() });
      wx.showToast({
        title: '类别已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存评分人类别失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveRule', false);
    }
  },

  async generateRuleCategories() {
    if (!this.data.currentActivityId) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    this.setLoading('generateRules', true);
    try {
      const result = await this.callCloud('generateRateTargetRules', {
        activityId: this.data.currentActivityId
      });

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '生成默认评分人类别失败',
          icon: 'none'
        });
        return;
      }

      await this.reloadRuleListWithRetry(result.ruleCount || 0);
      wx.showToast({
        title: result.ruleCount ? '默认评分人类别已生成' : '没有可生成的评分人类别',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '生成默认评分人类别失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('generateRules', false);
    }
  },

  async generateRuleCategoriesSafe() {
    if (!this.data.currentActivityId) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    this.setLoading('generateRules', true);
    let result = null;
    try {
      result = await this.callCloud('generateRateTargetRules', {
        activityId: this.data.currentActivityId
      });

      if (!result || result.status !== 'success') {
        wx.showToast({
          title: (result && result.message) || '生成默认评分人类别失败',
          icon: 'none'
        });
        return;
      }

      for (const delay of [0, 200, 500]) {
        if (delay > 0) {
          await this.wait(delay);
        }
        try {
          const listResult = await this.callCloud('listRateRules', {
            activityId: this.data.currentActivityId
          });
          this.setRuleListState(listResult.rules || [], this.data.selectedRuleIds, this.data.ruleFilters);
          break;
        } catch (refreshError) {}
      }

      wx.showToast({
        title: '默认评分人类别已生成',
        icon: 'success'
      });
      return;

      wx.showToast({
        title: '默认评分人类别已生成',
        icon: 'success'
      });
    } catch (error) {
      if (result && result.status === 'success') {
        wx.showToast({
          title: '默认评分人类别已生成',
          icon: 'success'
        });
        return;

        wx.showToast({
          title: '默认评分人类别已生成',
          icon: 'success'
        });
        return;
      }

      wx.showToast({
        title: '生成默认评分人类别失败',
        icon: 'none'
      });
      return;

      wx.showToast({
        title: '生成默认评分人类别失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('generateRules', false);
    }
  },

  async generateRuleCategoriesFinal() {
    if (!this.data.currentActivityId) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    this.setLoading('generateRules', true);
    wx.showLoading({ title: '正在生成默认类别...', mask: true });
    let result = null;
    try {
      result = await this.callCloud('generateRateTargetRules', {
        activityId: this.data.currentActivityId
      });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({
        title: '生成默认评分人类别失败',
        icon: 'none'
      });
      this.setLoading('generateRules', false);
      return;
    }

    if (!result || result.status !== 'success') {
      wx.hideLoading();
      wx.showToast({
        title: (result && result.message) || '生成默认评分人类别失败',
        icon: 'none'
      });
      this.setLoading('generateRules', false);
      return;
    }

    for (const delay of [0, 200, 500]) {
      if (delay > 0) {
        await this.wait(delay);
      }

      try {
        const listResult = await this.callCloud('listRateRules', {
          activityId: this.data.currentActivityId
        });
        this.setRuleListState(listResult.rules || [], this.data.selectedRuleIds, this.data.ruleFilters);
        break;
      } catch (refreshError) {}
    }

    wx.hideLoading();
    this.setLoading('generateRules', false);
    wx.showToast({
      title: `已生成 ${result.ruleCount || 0} 类评分人`,
      icon: 'none',
      duration: 2000
    });
  },

  async saveRule() {
    const { id, scorerDepartmentId, scorerDepartment, scorerIdentityId, scorerIdentity, clauses } = this.data.ruleForm;
    const currentActivity = (this.data.activityList || []).find((item) => item.id === this.data.currentActivityId);
    if (!this.data.currentActivityId || !currentActivity) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }
    if (!scorerDepartmentId || !scorerIdentityId) {
      wx.showToast({
        title: '请填写完整评分人类别',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveRule', true);
    try {
      const result = await this.callCloud('saveRateRule', {
        id,
        activityId: this.data.currentActivityId,
        activityName: currentActivity.name || '',
        scorerDepartmentId,
        scorerIdentityId,
        clauses
      });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存失败',
          icon: 'none'
        });
        return;
      }

      this.setData({ ruleForm: emptyRuleForm() });
      await this.loadRuleList();
      wx.showToast({
        title: '类别已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存评分人类别失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveRule', false);
    }
  },

  deleteRule(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除评分人类别',
      content: '确认删除这条评分人类别吗？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }
        try {
          await this.callCloud('deleteRateRule', { id });
          await this.loadRuleList();
          wx.showToast({
            title: '已删除',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '删除失败',
            icon: 'none'
          });
        }
      }
    });
  },

  async generateDefaultRules() {
    if (!this.data.currentActivityId) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    this.setLoading('generateRules', true);
    try {
      const result = await this.callCloud('generateRateTargetRules', {
        activityId: this.data.currentActivityId
      });
      wx.showToast({
        title: result.ruleCount ? '默认评分人类别已生成' : '没有可生成的评分人类别',
        icon: 'none'
      });
      await this.loadRuleList();
    } catch (error) {
      wx.showToast({
        title: '生成默认评分人类别失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('generateRules', false);
    }
  },

  async loadHrProfileAdminData() {
    this.setLoading('profile', true);
    try {
      const result = await this.callCloud('listHrProfileAdminData');
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '加载人事信息模板失败',
          icon: 'none'
        });
        return;
      }

      const template = result.template || null;
      const rawRows = result.rows || [];
      const hrProfileFilterOptions = buildHrProfileFilterOptions(rawRows);
      const hrProfileRows = applyHrProfileFilters(rawRows, this.data.hrProfileFilters);
      this.setData({
        hrProfileTemplateForm: template ? {
          description: template.description || '',
          editMode: template.editMode || PROFILE_EDIT_MODE_OPTIONS[0].value,
          editModeLabel: (PROFILE_EDIT_MODE_OPTIONS.find((item) => item.value === (template.editMode || PROFILE_EDIT_MODE_OPTIONS[0].value)) || PROFILE_EDIT_MODE_OPTIONS[0]).label,
          fields: Array.isArray(template.fields) && template.fields.length
            ? template.fields.map((item) => normalizeHrProfileFieldForForm(item))
            : [createEmptyProfileField()]
        } : emptyHrProfileTemplateForm(),
        hrProfileRawRows: rawRows,
        hrProfileFilterOptions,
        hrProfileRows
      });
    } catch (error) {
      wx.showToast({
        title: '加载人事信息模板失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('profile', false);
    }
  },

  refreshHrProfileRows(nextFilters = this.data.hrProfileFilters, nextRawRows = this.data.hrProfileRawRows) {
    this.setData({
      hrProfileRows: applyHrProfileFilters(nextRawRows, nextFilters)
    });
  },

  onHrProfileFilterChange(e) {
    const field = String(e.currentTarget.dataset.field || '');
    const options = this.data.hrProfileFilterOptions[field] || [];
    const keyMap = {
      departments: 'department',
      identities: 'identity',
      workGroups: 'workGroup',
      statuses: 'status'
    };
    const valueKey = keyMap[field] || 'status';
    const value = options[Number(e.detail.value)] || options[0] || '';
    const nextFilters = {
      ...this.data.hrProfileFilters,
      [valueKey]: value
    };
    this.setData({
      hrProfileFilters: nextFilters
    });
    this.refreshHrProfileRows(nextFilters);
  },

  onHrProfileKeywordInput(e) {
    const nextFilters = {
      ...this.data.hrProfileFilters,
      keyword: e.detail.value
    };
    this.setData({
      hrProfileFilters: nextFilters
    });
    this.refreshHrProfileRows(nextFilters);
  },

  resetHrProfileFilters() {
    const nextFilters = emptyHrProfileFilters();
    this.setData({
      hrProfileFilters: nextFilters
    });
    this.refreshHrProfileRows(nextFilters);
  },

  onHrProfileTemplateInput(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({
      hrProfileTemplateForm: {
        ...this.data.hrProfileTemplateForm,
        [field]: value
      }
    });
  },

  onHrProfileFieldInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const field = String(e.currentTarget.dataset.field || '');
    const fields = [...(this.data.hrProfileTemplateForm.fields || [])];
    if (!fields[index]) {
      return;
    }

    fields[index] = {
      ...fields[index],
      [field]: e.detail.value
    };

    this.setData({
      'hrProfileTemplateForm.fields': fields
    });
  },

  onHrProfileFieldRequiredChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const fields = [...(this.data.hrProfileTemplateForm.fields || [])];
    if (!fields[index]) {
      return;
    }

    fields[index] = {
      ...fields[index],
      required: !!e.detail.value
    };

    this.setData({
      'hrProfileTemplateForm.fields': fields
    });
  },

  onHrProfileEditModeChange(e) {
    const option = PROFILE_EDIT_MODE_OPTIONS[Number(e.detail.value)] || PROFILE_EDIT_MODE_OPTIONS[0];
    this.setData({
      hrProfileTemplateForm: {
        ...this.data.hrProfileTemplateForm,
        editMode: option.value,
        editModeLabel: option.label
      }
    });
  },

  onHrProfileFieldTypeChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const option = PROFILE_FIELD_TYPE_OPTIONS[Number(e.detail.value)] || PROFILE_FIELD_TYPE_OPTIONS[0];
    const fields = [...(this.data.hrProfileTemplateForm.fields || [])];
    if (!fields[index]) {
      return;
    }

    fields[index] = {
      ...fields[index],
      type: option.value,
      typeLabel: option.label
    };

    this.setData({
      'hrProfileTemplateForm.fields': fields
    });
  },

  onHrProfileNumberRuleChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const option = NUMBER_RULE_OPTIONS[Number(e.detail.value)] || NUMBER_RULE_OPTIONS[0];
    const fields = [...(this.data.hrProfileTemplateForm.fields || [])];
    if (!fields[index]) {
      return;
    }

    fields[index] = {
      ...fields[index],
      numberRule: option.value,
      numberRuleLabel: option.label
    };

    this.setData({
      'hrProfileTemplateForm.fields': fields
    });
  },

  onHrProfileFieldAllowDecimalChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const fields = [...(this.data.hrProfileTemplateForm.fields || [])];
    if (!fields[index]) {
      return;
    }

    fields[index] = {
      ...fields[index],
      allowDecimal: !!e.detail.value
    };

    this.setData({
      'hrProfileTemplateForm.fields': fields
    });
  },

  addHrProfileField() {
    this.setData({
      'hrProfileTemplateForm.fields': [
        ...(this.data.hrProfileTemplateForm.fields || []),
        createEmptyProfileField()
      ]
    });
  },

  removeHrProfileField(e) {
    const index = Number(e.currentTarget.dataset.index);
    const fields = [...(this.data.hrProfileTemplateForm.fields || [])];
    if (!fields[index]) {
      return;
    }

    fields.splice(index, 1);
    this.setData({
      'hrProfileTemplateForm.fields': fields.length ? fields : [createEmptyProfileField()]
    });
  },

  async saveHrProfileTemplate() {
    const form = this.data.hrProfileTemplateForm || emptyHrProfileTemplateForm();
    const fields = (form.fields || []).map((item) => ({
      id: item.id,
      label: String(item.label || '').trim(),
      type: item.type,
      required: item.required === true,
      minLength: item.minLength === '' ? null : Number(item.minLength),
      maxLength: item.maxLength === '' ? null : Number(item.maxLength),
      numberRule: item.numberRule || NUMBER_RULE_OPTIONS[0].value,
      allowDecimal: item.allowDecimal !== false,
      minDigits: item.minDigits === '' ? null : Number(item.minDigits),
      maxDigits: item.maxDigits === '' ? null : Number(item.maxDigits),
      minValue: item.minValue === '' ? null : Number(item.minValue),
      maxValue: item.maxValue === '' ? null : Number(item.maxValue),
      options: String(item.optionsText || '')
        .split('\n')
        .map((option) => option.trim())
        .filter(Boolean)
    }));

    if (!fields.length || fields.some((item) => !item.label)) {
      wx.showToast({
        title: '请填写完整的字段名称',
        icon: 'none'
      });
      return;
    }

    this.setLoading('saveProfileTemplate', true);
    wx.showLoading({
      title: '更新中...',
      mask: true
    });
    try {
      const result = await this.callCloud('saveHrProfileTemplate', {
        description: String(form.description || '').trim(),
        editMode: form.editMode,
        fields
      });

      if (result.status !== 'success') {
        showShortToast('更新失败');
        return;
      }

      await this.loadHrProfileAdminData();
      showShortToast('已更新', 'success');
    } catch (error) {
      showShortToast('更新失败');
    } finally {
      wx.hideLoading();
      this.setLoading('saveProfileTemplate', false);
    }
  },

  approveHrProfileChange(e) {
    const studentId = String(e.currentTarget.dataset.studentId || '').trim();
    if (!studentId) {
      return;
    }

    wx.showModal({
      title: '通过审核',
      content: '确认将待审核的人事信息修改正式生效吗？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }

        try {
          const result = await this.callCloud('reviewHrProfileChange', {
            studentId,
            action: 'approve'
          });
          if (result.status !== 'success') {
            wx.showToast({
              title: result.message || '审核失败',
              icon: 'none'
            });
            return;
          }
          await this.loadHrProfileAdminData();
          wx.showToast({
            title: '已通过审核',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '审核失败',
            icon: 'none'
          });
        }
      }
    });
  },

  rejectHrProfileChange(e) {
    const studentId = String(e.currentTarget.dataset.studentId || '').trim();
    if (!studentId) {
      return;
    }

    wx.showModal({
      title: '驳回修改',
      content: '确认驳回这次待审核的人事信息修改吗？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }

        try {
          const result = await this.callCloud('reviewHrProfileChange', {
            studentId,
            action: 'reject'
          });
          if (result.status !== 'success') {
            wx.showToast({
              title: result.message || '驳回失败',
              icon: 'none'
            });
            return;
          }
          await this.loadHrProfileAdminData();
          wx.showToast({
            title: '已驳回修改',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '驳回失败',
            icon: 'none'
          });
        }
      }
    });
  },

  onHrFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value.trim();
    this.setData({
      hrForm: {
        ...this.data.hrForm,
        [field]: value
      }
    });
  },

  editHr(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.hrList[index];
    if (!item) {
      return;
    }

    this.setData({
      hrForm: {
        id: item.id,
        name: item.name,
        studentId: item.studentId,
        departmentId: item.departmentId || '',
        department: item.department,
        identityId: item.identityId || '',
        identity: item.identity,
        workGroupId: item.workGroupId || '',
        workGroup: item.workGroup || ''
      },
      activeTab: 'hr'
    });
  },

  resetHrForm() {
    this.setData({
      hrForm: emptyHrForm()
    });
  },

  startCreateHr() {
    this.resetHrForm();
    this.setData({ activeTab: 'hr' });
  },

  async saveHr() {
    const { id, name, studentId, departmentId, identityId, workGroupId } = this.data.hrForm;
  
    if (!name || !studentId || !departmentId || !identityId) {
      wx.showToast({
        title: '请填写完整人事信息',
        icon: 'none'
      });
      return;
    }
  
    this.setLoading('saveHr', true);
    try {
      const result = await this.callCloud('saveHrInfo', {
        id,
        name,
        studentId,
        departmentId,
        identityId,
        workGroupId
      });
  
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存失败',
          icon: 'none'
        });
        return;
      }
  
      this.resetHrForm();
      await this.loadHrList();
      wx.showToast({
        title: '人事成员已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存人事成员失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveHr', false);
    }
  },

  deleteHr(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除人事成员',
      content: '删除后会同步清理关联绑定记录，是否继续？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }
        try {
          await this.callCloud('deleteHrInfo', { id });
          await this.loadHrList();
          wx.showToast({
            title: '已删除',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '删除失败',
            icon: 'none'
          });
        }
      }
    });
  },

  chooseCsv() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['csv'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) {
          return;
        }

        wx.getFileSystemManager().readFile({
          filePath: file.path,
          encoding: 'utf8',
          success: async (readRes) => {
            try {
              let startIndex = 1;
              let totalCount = 0;
              let hasMore = true;
              this.setLoading('importCsv', true);

              while (hasMore) {
                wx.showLoading({
                  title: `正在导入${totalCount > 0 ? '（已导入' + totalCount + '条）' : '...'}`,
                  mask: true
                });

                const result = await this.callCloud('importHrCsv', {
                  csvContent: readRes.data,
                  startIndex,
                  batchSize: 100
                });

                if (result.status !== 'success') {
                  wx.hideLoading();
                  wx.showToast({ title: result.message || '导入失败', icon: 'none' });
                  this.setLoading('importCsv', false);
                  return;
                }

                totalCount += Number(result.count || 0);
                startIndex = Number(result.nextIndex || startIndex + 100);
                hasMore = !!result.hasMore;
              }

              wx.hideLoading();
              this.setLoading('importCsv', false);
              this.setData({ csvName: file.name || '已导入 CSV' });
              await this.loadHrList();
              wx.showToast({ title: `导入成功，共 ${totalCount} 条`, icon: 'success' });
            } catch (error) {
              wx.hideLoading();
              this.setLoading('importCsv', false);
              wx.showToast({ title: 'CSV 导入失败', icon: 'none' });
            }
          }
        });
      }
    });
  },

  onAdminFieldInput(e) {
    const { field } = e.currentTarget.dataset;
    const value = field === 'inviteCode'
      ? e.detail.value.trim().toUpperCase()
      : e.detail.value.trim();

    this.setData({
      adminForm: {
        ...this.data.adminForm,
        [field]: value
      }
    });
  },

  generateInviteCode() {
    if (!this.data.canManageAdmins) {
      return;
    }

    const inviteCode = createLocalInviteCode();
    this.setData({
      adminForm: {
        ...this.data.adminForm,
        inviteCode
      },
      latestInviteCode: inviteCode
    });

    wx.showToast({
      title: '邀请码已生成',
      icon: 'success'
    });
  },

  onAdminLevelChange(e) {
    const idx = Number(e.detail.value);
    let adminLevel;
    if (this.data.isRootAdmin) {
      adminLevel = idx === 0 ? 'admin' : (idx === 1 ? 'super_admin' : 'root_admin');
    } else {
      adminLevel = idx === 0 ? 'admin' : 'super_admin';
    }
    this.setData({
      adminLevelIndex: idx,
      adminForm: {
        ...this.data.adminForm,
        adminLevel
      }
    });
  },

  onAdminCandidateKeyword(e) {
    this.refreshAdminCandidates(e.detail.value);
  },

  onAdminCandidateConfirm(e) {
    this.refreshAdminCandidates(e.detail.value);
  },

  pickAdminCandidate(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.adminCandidateList[index];
    if (!item) {
      return;
    }

    this.setData({
      adminForm: {
        ...this.data.adminForm,
        name: item.name,
        studentId: item.studentId
      }
    });

    wx.showToast({
      title: '已填入管理员信息',
      icon: 'none'
    });
  },

  editAdmin(e) {
    if (!this.data.canManageAdmins) {
      return;
    }

    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.adminList[index];
    if (!item) {
      return;
    }

    const adminLevel = item.adminLevel || 'admin';
    const idx = this.data.isRootAdmin
      ? (adminLevel === 'root_admin' ? 2 : (adminLevel === 'super_admin' ? 1 : 0))
      : (adminLevel === 'super_admin' ? 1 : 0);

    this.setData({
      adminLevelIndex: idx,
      adminForm: {
        id: item.id,
        name: item.name,
        studentId: item.studentId,
        adminLevel,
        inviteCode: item.inviteCode || ''
      },
      latestInviteCode: '',
      activeTab: 'admins'
    });
  },

  resetAdminForm() {
    this.setData({
      adminForm: emptyAdminForm(),
      adminLevelIndex: 0,
      latestInviteCode: ''
    });
  },

  startCreateAdmin() {
    if (!this.data.canManageAdmins) {
      return;
    }

    this.resetAdminForm();
    this.setData({ activeTab: 'admins' });
  },

  async saveAdmin() {
    if (!this.data.canManageAdmins) {
      return;
    }

    const form = this.data.adminForm;
    if (!form.name || !form.studentId) {
      wx.showToast({
        title: '请填写管理员姓名和学号',
        icon: 'none'
      });
      return;
    }

    let inviteCode = String(form.inviteCode || '').trim().toUpperCase();
    if (!inviteCode) {
      inviteCode = createLocalInviteCode();
      this.setData({
        adminForm: {
          ...this.data.adminForm,
          inviteCode
        },
        latestInviteCode: inviteCode
      });
    }

    this.setLoading('saveAdmin', true);
    try {
      const result = await this.callCloud('saveAdmin', {
        ...form,
        inviteCode
      });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存失败',
          icon: 'none'
        });
        return;
      }

      this.resetAdminForm();
      this.setData({
        latestInviteCode: result.inviteCode || ''
      });
      await this.loadAdminList();
      wx.showToast({
        title: '管理员已保存',
        icon: 'success'
      });
    } catch (error) {
      wx.showToast({
        title: '保存管理员失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('saveAdmin', false);
    }
  },

  async exportAdmins() {
    if (!this.data.isSuperAdmin && !this.data.isRootAdmin) {
      return;
    }

    this.setLoading('exportAdmins', true);
    try {
      const result = await this.callCloud('exportAdmins');
      if (result.status !== 'success' || !result.csvContent) {
        wx.showToast({
          title: result.message || '导出失败',
          icon: 'none'
        });
        return;
      }

      const filePath = `${wx.env.USER_DATA_PATH}/admin_info_export_${Date.now()}.csv`;
      await new Promise((resolve, reject) => {
        wx.getFileSystemManager().writeFile({
          filePath,
          data: result.csvContent,
          encoding: 'utf8',
          success: resolve,
          fail: reject
        });
      });

      wx.openDocument({
        filePath,
        fileType: 'csv',
        showMenu: true,
        fail: () => {
          wx.showToast({
            title: '已导出到本地文件',
            icon: 'none'
          });
        }
      });
    } catch (error) {
      wx.showToast({
        title: '导出管理员失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('exportAdmins', false);
    }
  },


  deleteAdmin(e) {
    if (!this.data.canManageAdmins) {
      return;
    }

    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除管理员',
      content: '删除后如果没有其他至高权限管理员，将被阻止。是否继续？',
      success: async (res) => {
        if (!res.confirm) {
          return;
        }
        try {
          const result = await this.callCloud('deleteAdmin', { id });
          if (result.status !== 'success') {
            wx.showToast({
              title: result.message || '删除失败',
              icon: 'none'
            });
            return;
          }
          await this.loadAdminList();
          wx.showToast({
            title: '管理员已删除',
            icon: 'success'
          });
        } catch (error) {
          wx.showToast({
            title: '删除管理员失败',
            icon: 'none'
          });
        }
      }
    });
  }
});
