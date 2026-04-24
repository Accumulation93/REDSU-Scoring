const STORAGE_KEY = 'roleProfiles';
const TAB_LIST = ['activities', 'templates', 'rules', 'results', 'hr', 'admins'];
const RULE_SCOPE_OPTIONS = [
  { value: 'same_department_identity', label: '同一部门内的指定身份成员' },
  { value: 'same_department_all', label: '同一部门内的所有成员' },
  { value: 'same_work_group_identity', label: '同一部门同一职能组内的指定身份成员' },
  { value: 'same_work_group_all', label: '同一部门同一职能组内的所有成员' },
  { value: 'identity_only', label: '全体成员中的指定身份' },
  { value: 'all_people', label: '全体成员' }
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
    scorerDepartment: '',
    scorerIdentity: '',
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

function emptyAdminForm() {
  return {
    id: '',
    name: '',
    studentId: '',
    adminLevel: 'admin',
    inviteCode: ''
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
    : (clause.templateId ? [createTemplateConfig({
      templateId: clause.templateId,
      templateName: clause.templateName,
      weight: clause.weight == null ? 1 : clause.weight,
      sortOrder: clause.sortOrder == null ? 1 : clause.sortOrder
    })] : []);

  return {
    scopeType: clause.scopeType || RULE_SCOPE_OPTIONS[0].value,
    scopeLabel: getScopeLabel(clause.scopeType || RULE_SCOPE_OPTIONS[0].value),
    targetIdentity: clause.targetIdentity || '',
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

function buildResultFilterOptions(values = []) {
  return ['全部', ...values.filter(Boolean)];
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
    activeTab: TAB_LIST[0],
    loadingMap: {},
    scopeOptions: RULE_SCOPE_OPTIONS,
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
    selectedRuleIds: [],
    selectedRuleIdMap: {},
    resultFilters: emptyResultFilters(),
    resultFilterOptions: {
      departments: ['全部'],
      identities: ['全部'],
      workGroups: ['全部']
    },
    resultViewOptions: [
      { value: 'overview', label: '总分速览' },
      { value: 'calculation', label: '总分计算表' },
      { value: 'detail', label: '评分明细' },
      { value: 'completion', label: '完成率看板' },
      { value: 'records', label: '评分记录管理' }
    ],
    resultViewLabel: '总分速览',
    resultSortOptions: [
      { value: 'score_desc', label: '按分数从高到低' },
      { value: 'name_asc', label: '按姓名首字母' },
      { value: 'department_asc', label: '按所属部门' },
      { value: 'workGroup_asc', label: '按职能组' }
    ],
    resultSortLabel: '按分数从高到低',
    scoreResultsRaw: {
      overviewRows: [],
      calculationRows: [],
      detailRows: [],
      recordRows: [],
      scorerCompletionRows: [],
      completionBoards: {
        departments: [],
        identities: [],
        workGroups: []
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
    completionBoardPopupVisible: false,
    completionBoardPopupTitle: '',
    completionBoardPopupRows: [],
    hrForm: emptyHrForm(),
    hrList: [],
    adminForm: emptyAdminForm(),
    adminList: [],
    latestInviteCode: '',
    csvName: ''
  },

  onShow() {
    this.bootstrapPage();
  },

  async bootstrapPage() {
    const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
    const adminProfile = roleProfiles.admin;
    const isSuperAdmin = !!adminProfile && adminProfile.adminLevel === 'super_admin';

    if (!adminProfile) {
      this.setData({
        user: null,
        hasPermission: false,
        isSuperAdmin: false,
        canManageAdmins: false
      });
      return;
    }

    this.setData({
      user: adminProfile,
      hasPermission: true,
      isSuperAdmin,
      canManageAdmins: isSuperAdmin,
      resultFilterOptions: {
        departments: ['全部'],
        identities: ['全部'],
        workGroups: ['全部']
      },
      resultViewOptions: [
        { value: 'overview', label: '总分速览' },
        { value: 'calculation', label: '总分计算表' },
        { value: 'detail', label: '评分明细' },
        { value: 'completion', label: '完成率看板' },
        { value: 'records', label: '评分记录管理' }
      ],
      resultViewLabel: '总分速览',
      resultSortOptions: [
        { value: 'score_desc', label: '按分数从高到低' },
        { value: 'name_asc', label: '按姓名首字母' },
        { value: 'department_asc', label: '按所属部门' },
        { value: 'workGroup_asc', label: '按职能组' }
      ],
      resultSortLabel: '按分数从高到低'
    });

    await this.loadActivityList();
    this.loadTemplateList();
    this.loadRuleList();
    this.loadHrList();
    this.loadAdminList();
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
      this.loadScoreResults();
    }
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
    this.setLoading('rules', true);
    try {
      if (!this.data.currentActivityId) {
        this.setData({
          ruleList: [],
          selectedRuleIds: [],
          selectedRuleIdMap: {}
        });
        return;
      }

      const result = await this.callCloud('listRateRules', {
        activityId: this.data.currentActivityId
      });
      const rawRuleList = result.rules || [];
      const ruleIdSet = new Set(rawRuleList.map((item) => item.id));
      const selectedRuleIds = (this.data.selectedRuleIds || []).filter((id) => ruleIdSet.has(id));
      const ruleList = markSelectedRules(rawRuleList, selectedRuleIds);
      this.setData({
        ruleList,
        selectedRuleIds,
        selectedRuleIdMap: createSelectedRuleIdMap(selectedRuleIds)
      });
    } catch (error) {
      wx.showToast({
        title: '加载评分人类别失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('rules', false);
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

  async loadScoreResults() {
    if (!this.data.currentActivityId) {
      this.setData({
        scoreResultsRaw: {
          overviewRows: [],
          calculationRows: [],
          detailRows: [],
          recordRows: [],
          scorerCompletionRows: [],
          completionBoards: {
            departments: [],
            identities: [],
            workGroups: []
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
        resultFilterOptions: {
          departments: ['全部'],
          identities: ['全部'],
          workGroups: ['全部']
        },
        completionBoardPopupVisible: false,
        completionBoardPopupTitle: '',
        completionBoardPopupRows: []
      });
      return;
    }

    this.setLoading('results', true);
    try {
      const result = await this.callCloud('getScoreResults', {
        activityId: this.data.currentActivityId
      });

      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '加载评分结果失败',
          icon: 'none'
        });
        return;
      }

      const filterOptions = {
        departments: buildResultFilterOptions(result.filterOptions && result.filterOptions.departments || []),
        identities: buildResultFilterOptions(result.filterOptions && result.filterOptions.identities || []),
        workGroups: buildResultFilterOptions(result.filterOptions && result.filterOptions.workGroups || [])
      };

      this.setData({
        scoreResultsRaw: {
          overviewRows: result.overviewRows || [],
          calculationRows: result.calculationRows || [],
          detailRows: result.detailRows || [],
          recordRows: result.recordRows || [],
          scorerCompletionRows: result.scorerCompletionRows || [],
          completionBoards: result.completionBoards || {
            departments: [],
            identities: [],
            workGroups: []
          },
          stats: result.stats || {}
        },
        resultFilterOptions: filterOptions,
        completionBoardPopupVisible: false,
        completionBoardPopupTitle: '',
        completionBoardPopupRows: []
      });
      this.applyScoreResultFilters();
    } catch (error) {
      wx.showToast({
        title: '加载评分结果失败',
        icon: 'none'
      });
    } finally {
      this.setLoading('results', false);
    }
  },

  applyScoreResultFilters() {
    const filters = this.data.resultFilters || emptyResultFilters();
    const matches = (row) => {
      if (filters.department !== '全部' && row.department !== filters.department) {
        return false;
      }
      if (filters.identity !== '全部' && row.identity !== filters.identity) {
        return false;
      }
      if (filters.workGroup !== '全部' && (row.workGroup || '未分组') !== filters.workGroup) {
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
    const recordRows = sortRows((this.data.scoreResultsRaw.recordRows || []).filter(matches), 'weightedTotalScore');
    const completionSourceRows = (this.data.scoreResultsRaw.scorerCompletionRows || []).filter(matches).filter((row) => Number(row.expectedCount || 0) > 0);
    const buildBoard = (field) => {
      const map = {};
      completionSourceRows.forEach((row) => {
        const key = row[field] || '未设置';
        if (!map[key]) {
          map[key] = {
            groupName: key,
            memberCount: 0,
            completedCount: 0,
            expectedCount: 0,
            submittedCount: 0,
            pendingCount: 0,
            scorerRows: []
          };
        }
        const expectedCount = Math.max(0, Math.floor(toNumber(row.expectedCount, 0)));
        const submittedCount = Math.max(0, Math.floor(toNumber(row.submittedCount, 0)));
        const pendingCount = Math.max(expectedCount - submittedCount, 0);
        const isCompleted = pendingCount === 0;
        map[key].memberCount += 1;
        map[key].completedCount += isCompleted ? 1 : 0;
        map[key].expectedCount += expectedCount;
        map[key].submittedCount += submittedCount;
        map[key].pendingCount += pendingCount;
        map[key].scorerRows.push({
          ...row,
          expectedCount,
          submittedCount,
          pendingCount,
          completionText: `${submittedCount}/${expectedCount}`,
          progressPercentText: `${expectedCount ? Math.round((submittedCount / expectedCount) * 100) : 100}%`,
          progressFillStyle: buildProgressFillStyle(expectedCount ? (submittedCount / expectedCount) * 100 : 100),
          statusText: pendingCount > 0 ? '未完成' : '已完成',
          statusClass: pendingCount > 0 ? 'status-pending' : 'status-completed'
        });
      });
      return Object.keys(map).map((key) => {
        const item = map[key];
        const percent = item.memberCount
          ? clampNumber((item.completedCount / item.memberCount) * 100, 0, 100)
          : 100;
      
        return {
          ...item,
          completionRate: Number(percent.toFixed(2)),
          completionText: `${item.completedCount}/${item.memberCount}`,
          progressPercentText: `${Math.round(percent)}%`,
          progressFillStyle: buildProgressFillStyle(percent),
          scorerRows: item.scorerRows.sort((a, b) => {
            const pendingDiff = Number(b.pendingCount || 0) - Number(a.pendingCount || 0);
            if (pendingDiff !== 0) {
              return pendingDiff;
            }
            return String(a.scorerName || '').localeCompare(String(b.scorerName || ''), 'zh-CN');
          })
        };
      }).sort((a, b) => {
        const rateDiff = Number(b.completionRate || 0) - Number(a.completionRate || 0);
        if (rateDiff !== 0) {
          return rateDiff;
        }
        return String(a.groupName || '').localeCompare(String(b.groupName || ''), 'zh-CN');
      });
    };

    this.setData({
      scoreResultsView: {
        overviewRows,
        calculationRows,
        detailRows,
        recordRows,
        scorerCompletionRows: completionSourceRows,
        completionBoards: {
          departments: buildBoard('department'),
          identities: [],
          workGroups: []
        }
      }
    });
  },

  openCompletionBoardPopup(e) {
    const { groupName } = e.currentTarget.dataset;
    const departmentBoards = (this.data.scoreResultsView.completionBoards || {}).departments || [];
    const targetBoard = departmentBoards.find((item) => item.groupName === groupName);
    if (!targetBoard) {
      return;
    }

    this.setData({
      completionBoardPopupVisible: true,
      completionBoardPopupTitle: `${targetBoard.groupName}评分人完成情况`,
      completionBoardPopupRows: (targetBoard.scorerRows || []).map((item) => ({
        ...item,
        detailText: [item.identity, item.workGroup].filter(Boolean).join(' / ') || '未设置',
        completionText: item.completionText || `${item.submittedCount || 0}/${item.expectedCount || 0}`
      }))
    });
  },

  closeCompletionBoardPopup() {
    this.setData({
      completionBoardPopupVisible: false,
      completionBoardPopupTitle: '',
      completionBoardPopupRows: []
    });
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
        resultViewLabel: (this.data.resultViewOptions[Number(value)] || {}).label || '总分速览'
      });
    }
    if (field === 'sortMode') {
      nextValue = (this.data.resultSortOptions[Number(value)] || {}).value || 'score_desc';
      this.setData({
        resultSortLabel: (this.data.resultSortOptions[Number(value)] || {}).label || '按分数从高到低'
      });
    }

    this.setData({
      resultFilters: {
        ...this.data.resultFilters,
        [field]: nextValue
      }
    });
    this.applyScoreResultFilters();
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
      await new Promise((resolve, reject) => {
        wx.getFileSystemManager().writeFile({
          filePath,
          data: result.fileContent,
          encoding: 'utf8',
          success: resolve,
          fail: reject
        });
      });

      wx.openDocument({
        filePath,
        fileType: extension,
        showMenu: true,
        fail: () => {
          wx.showToast({
            title: '文件已生成到本地',
            icon: 'none'
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
      await this.loadScoreResults();
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

  toggleRuleSelection(e) {
    const { id, index } = e.currentTarget.dataset;
    const targetId = String(id || (((this.data.ruleList || [])[Number(index)] || {}).id) || '').trim();
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
    this.setData({
      selectedRuleIds: nextSelectedRuleIds,
      selectedRuleIdMap: createSelectedRuleIdMap(nextSelectedRuleIds),
      ruleList: markSelectedRules(this.data.ruleList, nextSelectedRuleIds)
    });
  },

  toggleSelectAllRules() {
    const ruleIds = (this.data.ruleList || []).map((item) => item.id);
    const isAllSelected = ruleIds.length > 0 && ruleIds.length === (this.data.selectedRuleIds || []).length;
    const selectedRuleIds = isAllSelected ? [] : ruleIds;

    this.setData({
      selectedRuleIds,
      selectedRuleIdMap: createSelectedRuleIdMap(selectedRuleIds),
      ruleList: markSelectedRules(this.data.ruleList, selectedRuleIds)
    });
  },

  async applyClausesToSelectedRules() {
    const selectedRules = (this.data.ruleList || []).filter((item) => (this.data.selectedRuleIds || []).includes(item.id));
    const clauses = this.data.ruleForm.clauses || [];
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

    if (!clauses.length) {
      wx.showToast({
        title: '请先准备好要批量应用的被评分人规则',
        icon: 'none'
      });
      return;
    }

    this.setLoading('batchSaveRules', true);
    try {
      for (const rule of selectedRules) {
        const result = await this.callCloud('saveRateRule', {
          id: rule.id,
          activityId: this.data.currentActivityId,
          activityName: currentActivity.name || '',
          scorerDepartment: rule.scorerDepartment,
          scorerIdentity: rule.scorerIdentity,
          clauses
        });

        if (result.status !== 'success') {
          wx.showToast({
            title: result.message || (`批量设置失败：${rule.scorerDepartment}/${rule.scorerIdentity}`),
            icon: 'none'
          });
          return;
        }
      }

      await this.loadRuleList();
      wx.showToast({
        title: '已批量更新选中类别',
        icon: 'success'
      });
    } catch (error) {
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
      clauseTemplateOrder,
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

    const sortOrderValue = clauseTemplateOrder === ''
      ? (clauseTemplateConfigs.length + 1)
      : Number(clauseTemplateOrder);

    if (!Number.isInteger(sortOrderValue) || sortOrderValue <= 0) {
      wx.showToast({
        title: '呈现顺序必须为正整数',
        icon: 'none'
      });
      return;
    }

    const nextConfig = {
      templateId: clauseTemplateId,
      templateName: clauseTemplateName,
      weight: String(weight),
      sortOrder: String(sortOrderValue)
    };

    const exists = clauseTemplateConfigs.some((item, index) => (
      index !== clauseTemplateConfigEditingIndex &&
      item.templateId === nextConfig.templateId &&
      String(item.sortOrder) === String(nextConfig.sortOrder)
    ));

    if (exists) {
      wx.showToast({
        title: '相同评分问题与顺序的配置已存在',
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
        clauseTemplateConfigEditingIndex: -1
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
        clauseTemplateConfigEditingIndex: index
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
        clauseTemplateConfigEditingIndex: -1
      }
    });
  },

  addRuleClause() {
    const {
      clauseScope,
      clauseTargetIdentity,
      clauseRequireAllComplete,
      clauseEditingIndex,
      clauseTemplateConfigs,
      clauses
    } = this.data.ruleForm;
    if (clauseScope !== 'all_people' && !clauseTargetIdentity && clauseScope.indexOf('_all') === -1) {
      wx.showToast({
        title: '请填写被评分人身份',
        icon: 'none'
      });
      return;
    }

    const nextClause = {
      scopeType: clauseScope,
      scopeLabel: getScopeLabel(clauseScope),
      targetIdentity: clauseTargetIdentity,
      requireAllComplete: !!clauseRequireAllComplete,
      templateConfigs: [...clauseTemplateConfigs].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder))
    };

    const exists = clauses.some((item, index) => (
      index !== clauseEditingIndex &&
      item.scopeType === nextClause.scopeType &&
      item.targetIdentity === nextClause.targetIdentity &&
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
        clauseTargetIdentity: '',
        clauseRequireAllComplete: false,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseEditingIndex: -1,
        clauseTemplateConfigs: []
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
        clauseEditingIndex: nextEditingIndex
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
        clauseTargetIdentity: targetClause.targetIdentity || '',
        clauseRequireAllComplete: targetClause.requireAllComplete === true,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseTemplateConfigs: refreshTemplateConfigSortOrder(normalizeClauseForEdit(targetClause).templateConfigs),
        clauseEditingIndex: index
      }
    });
  },

  cancelRuleClauseEdit() {
    this.setData({
      ruleForm: {
        ...this.data.ruleForm,
        clauseScope: RULE_SCOPE_OPTIONS[0].value,
        clauseScopeLabel: RULE_SCOPE_OPTIONS[0].label,
        clauseTargetIdentity: '',
        clauseRequireAllComplete: false,
        clauseTemplateId: '',
        clauseTemplateName: '',
        clauseTemplateWeight: '1',
        clauseTemplateOrder: '',
        clauseTemplateConfigEditingIndex: -1,
        clauseTemplateConfigs: [],
        clauseEditingIndex: -1
      }
    });
  },

  editRule(e) {
    const index = Number(e.currentTarget.dataset.index);
    const target = this.data.ruleList[index];
    if (!target) {
      return;
    }

    this.setData({
      ruleForm: {
        id: target.id,
        scorerDepartment: target.scorerDepartment,
        scorerIdentity: target.scorerIdentity,
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
        clauseTemplateConfigs: [],
        clauses: (target.clauses || []).map((item) => normalizeClauseForEdit(item))
      },
      activeTab: 'rules'
    });
  },

  async saveRuleCategory() {
    const { id, scorerDepartment, scorerIdentity, clauses } = this.data.ruleForm;
    const currentActivity = (this.data.activityList || []).find((item) => item.id === this.data.currentActivityId);
    if (!this.data.currentActivityId || !currentActivity) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }

    if (!scorerDepartment || !scorerIdentity) {
      wx.showToast({
        title: '请填写完整的评分人类别',
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
        scorerDepartment,
        scorerIdentity,
        clauses
      });
      if (result.status !== 'success') {
        wx.showToast({
          title: result.message || '保存评分人类别失败',
          icon: 'none'
        });
        return;
      }

      this.setData({ ruleForm: emptyRuleForm() });
      await this.loadRuleList();
      wx.showToast({
        title: '评分人类别已保存',
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
          const rawRuleList = listResult.rules || [];
          const ruleIdSet = new Set(rawRuleList.map((item) => item.id));
          const selectedRuleIds = (this.data.selectedRuleIds || []).filter((id) => ruleIdSet.has(id));
          const ruleList = markSelectedRules(rawRuleList, selectedRuleIds);
          this.setData({
            ruleList,
            selectedRuleIds,
            selectedRuleIdMap: createSelectedRuleIdMap(selectedRuleIds)
          });
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
    let result = null;
    try {
      result = await this.callCloud('generateRateTargetRules', {
        activityId: this.data.currentActivityId
      });
    } catch (error) {
      wx.showToast({
        title: '生成默认评分人类别失败',
        icon: 'none'
      });
      this.setLoading('generateRules', false);
      return;
    }

    if (!result || result.status !== 'success') {
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
        const rawRuleList = listResult.rules || [];
        const ruleIdSet = new Set(rawRuleList.map((item) => item.id));
        const selectedRuleIds = (this.data.selectedRuleIds || []).filter((id) => ruleIdSet.has(id));
        const ruleList = markSelectedRules(rawRuleList, selectedRuleIds);
        this.setData({
          ruleList,
          selectedRuleIds,
          selectedRuleIdMap: createSelectedRuleIdMap(selectedRuleIds)
        });
        break;
      } catch (refreshError) {}
    }

    this.setLoading('generateRules', false);
    wx.showToast({
      title: `已生成 ${result.ruleCount || 0} 类评分人`,
      icon: 'none',
      duration: 2000
    });
  },

  async saveRule() {
    const { id, scorerDepartment, scorerIdentity, clauses } = this.data.ruleForm;
    const currentActivity = (this.data.activityList || []).find((item) => item.id === this.data.currentActivityId);
    if (!this.data.currentActivityId || !currentActivity) {
      wx.showToast({
        title: '请先设置当前评分活动',
        icon: 'none'
      });
      return;
    }
    if (!scorerDepartment || !scorerIdentity) {
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
        scorerDepartment,
        scorerIdentity,
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
        title: '评分人类别已保存',
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
        department: item.department,
        identity: item.identity,
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
    const { id, name, studentId, department, identity, workGroup } = this.data.hrForm;
    if (!name || !studentId || !department || !identity) {
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
        department,
        identity,
        workGroup
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
              const result = await this.callCloud('importHrCsv', {
                csvContent: readRes.data
              });
              if (result.status !== 'success') {
                wx.showToast({
                  title: result.message || '导入失败',
                  icon: 'none'
                });
                return;
              }

              this.setData({
                csvName: file.name || '已导入 CSV'
              });
              await this.loadHrList();
              wx.showToast({
                title: 'CSV 导入成功',
                icon: 'success'
              });
            } catch (error) {
              wx.showToast({
                title: 'CSV 导入失败',
                icon: 'none'
              });
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
    const adminLevel = e.detail.value === '0' ? 'admin' : 'super_admin';
    this.setData({
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

    this.setData({
      adminForm: {
        id: item.id,
        name: item.name,
        studentId: item.studentId,
        adminLevel: item.adminLevel || 'admin',
        inviteCode: item.inviteCode || ''
      },
      latestInviteCode: '',
      activeTab: 'admins'
    });
  },

  resetAdminForm() {
    this.setData({
      adminForm: emptyAdminForm(),
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
    if (!this.data.isSuperAdmin) {
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
      content: '删除后如果没有其他超级管理员，将被阻止。是否继续？',
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
