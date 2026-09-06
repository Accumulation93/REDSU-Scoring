const generatedLocaleCopy = require('../../../../locales/zh-CN/generated/subpackages/scoring/pages/admin/admin');
const personnelLocaleCopy = require('../../../../locales/zh-CN/adminPersonnel');
const localeCopy = Object.freeze(Object.assign({}, generatedLocaleCopy, personnelLocaleCopy));
const { callFunction } = require('../../../../utils/api');
const { chooseTableFile, buildCsv, buildExcelXml, saveAndShareFile } = require('../../../../utils/tableFile');
const eventBus = require('../../../../utils/eventBus');
const orgSession = require('../../../../utils/orgSession');
const authContext = require('../../../../utils/authContext');
const adminPermissions = require('../../../../utils/adminPermissions');
const { navigateToTrustedRoute } = require('../../../../utils/trustedNavigation');
const utils = require('./modules/adminUtils');
const { TAB_LIST, TIMEZONE_OPTIONS, RULE_SCOPE_OPTIONS, VIEW_SCOPE_OPTIONS, VIEW_SCOPE_LABEL_MAP, RULE_SCOPE_LABEL_MAP, PROFILE_EDIT_MODE_OPTIONS, PROFILE_FIELD_TYPE_OPTIONS, NUMBER_RULE_OPTIONS, emptyActivityForm, emptyTemplateForm, emptyRuleForm, emptyHrForm, emptyDepartmentForm, emptyWorkGroupForm, emptyIdentityForm, emptyAdminForm, emptyHrProfileTemplateForm, emptyRuleFilters, emptyHrProfileFilters, emptyHrProfileFilterOptions, emptyResultFilters, buildRuleListItem, buildRuleFilterOptions, filterRuleList, getScopeLabel, normalizeRuleFilters, createSelectedRuleIdMap, markSelectedRules, getProgressColor, buildProgressFillStyle, toNumber, clampNumber, formatScoreFixed3, applyHrProfileFilters } = utils;

const sharedApi = require('./modules/sharedApi');
const activityBehavior = require('./modules/activityBehavior');
const templateBehavior = require('./modules/templateBehavior');
const ruleBehavior = require('./modules/ruleBehavior');
const resultBehavior = require('./modules/resultBehavior');
const hrInfoBehavior = require('./modules/hrInfoBehavior');
const departmentBehavior = require('./modules/departmentBehavior');
const workGroupBehavior = require('./modules/workGroupBehavior');
const identityBehavior = require('./modules/identityBehavior');
const adminManagementBehavior = require('./modules/adminManagementBehavior');
const settingsBehavior = require('./modules/settingsBehavior');
const publicationBehavior = require('./modules/publicationBehavior');
const auditBehavior = require('./modules/auditBehavior');
const stampGrantBehavior = require('./modules/stampGrantBehavior');
const authPersonnelBehavior = require('./modules/authPersonnelBehavior');
const dictionaryFeedbackBehavior = require('./modules/dictionaryFeedbackBehavior');

Page({
  behaviors: [
    sharedApi,
    dictionaryFeedbackBehavior,
    activityBehavior,
    templateBehavior,
    ruleBehavior,
    resultBehavior,
    hrInfoBehavior,
    departmentBehavior,
    workGroupBehavior,
    identityBehavior,
    adminManagementBehavior,
    settingsBehavior,
    publicationBehavior,
    auditBehavior,
    stampGrantBehavior,
    authPersonnelBehavior,
  ],
  data: {
    localeCopy,
    user: null,
    hasPermission: false,
    isSuperAdmin: false,
    canManageAdmins: false,
    canExportScoreResults: false,
    canRevokeScoreRecords: false,
    canManageHrPeople: false,
    canImportHr: false,
    canReviewHrProfile: false,
    canBrowseHrInfo: false,
    canManageHrProfileTemplates: false,
    canSelectHrProfileTemplate: false,
    canVerifyIdentity: false,
    canRecoverAccounts: false,
    canGlobalAccountManage: false,
    canManageAuthPolicy: false,
    canReadAdmins: false,
    canWriteAdmins: false,
    hrInfoMode: 'profiles',
    activeTab: utils.TAB_LIST[0],
    visibleTabs: utils.TAB_LIST,
    subAppLabel: '',
    loadingMap: {},
    organizationList: [],
    currentOrganizationId: null,
    currentOrganizationName: '',
    systemDefaultOrganizationId: null,
    systemDefaultOrganizationName: '',
    orgFormVisible: false,
    contextSwitchGuardVisible: false,
    orgFormData: { name: '' },
    scopeOptions: utils.RULE_SCOPE_OPTIONS,
    profileEditModeOptions: utils.PROFILE_EDIT_MODE_OPTIONS,
    profileFieldTypeOptions: utils.PROFILE_FIELD_TYPE_OPTIONS,
    numberRuleOptions: utils.NUMBER_RULE_OPTIONS,
    adminLevelOptions: [localeCopy.copy_fd31650797],
    adminLevelValues: ['admin'],
    participantGranularityOptions: [
      { value: 'assignment', label: localeCopy.copy_9fc4793280 }
    ],
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
    dragActive: false,
    draggingQuestionIndex: -1,
    dragInsertIndex: -1,
    dragGhostTop: 0,
    dragGhostLeft: 0,
    dragGhostWidth: 0,
    dragGhostVisible: false,
    dragTemplateInsertIndex: -1,
    dragTemplateGhostTop: 0,
    dragTemplateGhostLeft: 0,
    dragTemplateGhostWidth: 0,
    dragTemplateGhostVisible: false,
    templateConfigScrollTop: 0,
    clauseTemplateInlineEditIndex: -1,
    expandedQuestionIndex: -1,
    questionFocusIndex: -1,
    templateQuestionScrollInto: '',
    templateQuestionScrollTop: 0,
    questionInputValues: {},
    questionValidationErrors: {},
    // Template CSV import
    showTemplateCsvDialog: false,
    templateCsvHeaders: [],
    templateCsvSamples: [],
    templateCsvMapping: {},
    templateCsvFullRows: [],
    templateCsvReplaceMode: true,
    templateCsvImportRows: [],
    templateCsvImportMappingLabels: [],
    ruleList: [],
    ruleListView: [],
    selectedRuleIds: [],
    selectedRuleIdMap: {},
    visibleRuleAllSelected: false,
    ruleFilters: emptyRuleFilters(),
    ruleFilterOptions: {
      departments: [localeCopy.copy_31d4595959],
      identities: [localeCopy.copy_31d4595959]
    },
    resultFilters: emptyResultFilters(),
    resultFilterOptions: {
      departments: [localeCopy.copy_31d4595959],
      identities: [localeCopy.copy_31d4595959],
      workGroups: [localeCopy.copy_31d4595959]
    },
    resultViewOptions: [
      { value: 'overview', label: localeCopy.copy_a6f7e5f124 },
      { value: 'completion', label: localeCopy.copy_9d954432df }
    ],
    resultViewLabel: localeCopy.copy_a6f7e5f124,
    resultSortOptions: [
      { value: 'score_desc', label: localeCopy.copy_60c630a885 },
      { value: 'name_asc', label: localeCopy.copy_99f2be3030 },
      { value: 'department_asc', label: localeCopy.copy_d379421477 },
      { value: 'workGroup_asc', label: localeCopy.copy_8438adbb77 }
    ],
    resultSortLabel: localeCopy.copy_60c630a885,
    resultPagination: {
      overview: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      calculation: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      detail: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      completion: { page: 0, pageSize: 0, hasMore: true, total: 0 },
      records: { page: 0, pageSize: 0, hasMore: true, total: 0 }
    },
    // ── Overview result (loaded all at once, cached server‑side) ──

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
    hrProfileAdvancedFiltersVisible: false,
    hrProfileActiveFilterChips: [],
    hrProfileSearchFieldIndex: 0,
    hrProfileSortIndex: 0,
    hrProfileRows: [],
    hrProfileResultCount: 0,
    hrProfileVisibleCount: 0,
    hrProfileHasMore: false,
    hrProfileFields: [],
    hrGovernanceUnavailable: false,
    hrProfileExportVisible: false,
    hrProfileExportColumns: [],
    hrProfileExportSelectedCount: 0,
    hrProfileExportFormat: 'xlsx',
    hrProfileTemplateList: [],
    activeHrProfileSnapshot: null,
    showHrTemplateEditor: false,
    hrTemplateSwitchVisible: false,
    hrTemplateSwitchTarget: null,
    hrTemplateSwitchSources: [],
    hrTemplateSwitchActionOptions: [localeCopy.copy_44b682f101, localeCopy.copy_ca0f4c277a, localeCopy.copy_de101441cb],
    hrTemplateSwitchToken: '',
    hrTemplateSwitchSummary: null,
    _hrInfoKeywordInput: '',
    showHrPersonDetail: false,
    detailHrId: '',
    detailHrProfile: null,
    detailHrGovernance: null,
    detailHrTemplate: null,
    detailHrValues: {},
    detailWorkGroupOptions: [],
    detailDepartmentValue: 0,
    detailIdentityValue: 0,
    detailWorkGroupValue: 0,
    detailFieldValues: {},
    detailHrPendingValues: {},
    detailHrAuditStatus: '',
    detailHrAuditStatusText: '',
    detailHrRejectionReason: '',
    detailHrHasPending: false,
    detailHrMembershipStatus: 'active',
    detailHrReadOnly: false,
    detailHrJoinedAtText: '',
    detailHrLeftAtText: '',
    detailHrComparisonRows: [],
    detailHrHistoricalFields: [],
    detailHrReviewHistory: [],
    hrPermanentDeletionVisible: false,
    hrPermanentDeletionScope: 'membership',
    hrPermanentDeletionTarget: null,
    hrPermanentDeletionPreview: null,
    hrPermanentDeletionResult: null,
    hrPermanentDeletionBlockers: [],
    hrPermanentDeletionCleanup: [],
    hrPermanentDeletionRules: [],
    hrPermanentDeletionCleanupAccepted: false,
    hrPermanentDeletionConfirmation: '',
    hrPermanentDeletionLoading: false,
    loadingDetailHr: false,
    savingDetailHr: false,
    membershipAssignmentList: [],
    personIdentityOrganizations: [],
    globalAdminIdentities: [],
    identityManagementOrganizationId: '',
    canAddGlobalSuperAdmin: false,
    membershipAssignmentFormVisible: false,
    membershipAssignmentForm: {},
    assignmentDepartmentOptions: [],
    assignmentIdentityOptions: [],
    detailScrollTarget: '',
    assignmentKindOptions: [localeCopy.copy_1acba00634, localeCopy.copy_8b397940d8, localeCopy.copy_71a5b74266],
    assignmentKindValues: ['staff', 'liaison', 'other'],
    identityActionConfirmVisible: false,
    identityActionConfirmTitle: '',
    identityActionConfirmText: '',
    identityActionConfirmAction: null,
    assignmentDepartmentIndex: 0,
    assignmentIdentityIndex: 0,
    assignmentWorkGroupIndex: 0,
    assignmentWorkGroupOptions: [],
    reactivatingHrId: '',
    profileRejectVisible: false,
    profileRejectStudentId: '',
    profileRejectReason: '',
    personCorrectionVisible: false,
    personCorrectionPreview: null,
    personCorrectionConfirmed: false,
    personCorrectionProfileValues: {},
    showAddEditForm: false,
    showTemplateConfig: false,
    hrForm: emptyHrForm(),
    hrList: [],
    adminForm: emptyAdminForm(),
    adminFormVisible: false,
    adminDeleteConfirmVisible: false,
    adminDeleteConfirmId: '',
    adminDeleteConfirmName: '',
    adminLevelIndex: 0,
    adminList: [],
    csvName: '',
    showCsvMappingDialog: false,
    csvImportRows: [],
    csvImportHeaders: [],
    csvImportDataRows: [],
    csvImportSheetName: '',
    csvImportSourceType: '',
    csvImportFileName: '',
    csvImportSamples: [],
    csvImportLoading: false,
    csvImportSkipInvalid: false,
    showHrImportPreview: false,
    hrImportPreview: {
      fileName: '',
      sheetName: '',
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      newRecords: 0,
      updateRecords: 0,
      preservedEmptyFields: 0,
      mappings: [],
      ignoredColumns: [],
      newDepartments: [],
      newIdentities: [],
      newWorkGroups: [],
      canImport: false,
      skipInvalid: false
    },
    showValidationErrors: false,
    validationErrors: [],
    validationErrorCards: [],
    validationErrorSummary: '',
    departmentForm: emptyDepartmentForm(),
    departmentList: [],
    workGroupForm: emptyWorkGroupForm(),
    workGroupList: [],
    identityForm: emptyIdentityForm(),
    identityList: [],
    departmentOptions: [],
    identityOptions: [],
    workGroupOptions: [],
    timezoneOptions: utils.TIMEZONE_OPTIONS,
    timezoneIndex: 20,
    systemConfig: { timezone: 8 },
    // ─── Publication management ───
    publicationsLoading: false,
    pubBatchRunning: false,
    publicationList: [],
    publicationForm: { id: '', activityId: '', activityName: '', isPublished: false },

    // View rule category form (mirrors ruleForm pattern)
    pubViewRuleForm: { id: '', publicationId: '', granteeDepartmentId: '', granteeDepartment: '', granteeIdentityId: '', granteeIdentity: '', isClauseEditorVisible: false, clauseEditingIndex: -1, clauseScopeType: 'own_results', clauseScopeLabel: localeCopy.copy_9a4a6e8793, clauseTargetIdentityId: '', clauseTargetIdentity: '', clauseDisplayMode: 'score', clauseGradeBands: [], clauses: [] },
    pubViewRuleList: [], pubViewRuleListView: [],
    pubViewRuleFilters: { department: localeCopy.copy_31d4595959, identity: localeCopy.copy_31d4595959 },
    pubViewRuleFilterOptions: { departments: [localeCopy.copy_31d4595959], identities: [localeCopy.copy_31d4595959] },
    pubViewRuleSelectedIds: {},
    pubViewRuleAllSelected: false,

    // Merit rule category form (mirrors ruleForm pattern + quota fields)
    pubMeritRuleForm: { id: '', publicationId: '', granteeDepartmentId: '', granteeDepartment: '', granteeIdentityId: '', granteeIdentity: '', isClauseEditorVisible: false, clauseEditingIndex: -1, clauseScopeType: 'all_people', clauseScopeLabel: localeCopy.copy_9a2854d17d, clauseTargetIdentityId: '', clauseTargetIdentity: '', clauseQuotaLimit: 0, clauseRequireExactQuota: false, clauses: [] },
    pubMeritRuleList: [], pubMeritRuleListView: [],
    pubMeritRuleFilters: { department: localeCopy.copy_31d4595959, identity: localeCopy.copy_31d4595959 },
    pubMeritRuleFilterOptions: { departments: [localeCopy.copy_31d4595959], identities: [localeCopy.copy_31d4595959] },
    pubMeritRuleSelectedIds: {},
    pubMeritRuleAllSelected: false,

    // Designation picker (now uses clauseId)
    designationList: [],
    publicationAssignmentCandidates: [],
    showDesignationPicker: false,
    designationPickerClauseId: '',
    designationPickerPubId: '',
    designationPickerHrList: [],
    designationPickerFilteredList: [],
    designationPickerSelectedIds: [],
    designationPickerSelectedList: [],
    desigFilterDept: localeCopy.copy_31d4595959, desigFilterIdent: localeCopy.copy_31d4595959,
    desigFilterDeptOptions: [localeCopy.copy_31d4595959], desigFilterIdentOptions: [localeCopy.copy_31d4595959],
    desigSearchKeyword: '',
    viewScopeOptions: utils.VIEW_SCOPE_OPTIONS,
    viewScopeLabelMap: utils.VIEW_SCOPE_LABEL_MAP,
    displayModeOptions: [
      { value: 'score', label: localeCopy.copy_9f601dac32 },
      { value: 'grade', label: localeCopy.copy_24fb296f09 }
    ],
    // Grade band expand/collapse (Feature 4)
    expandedGradeBandIndex: -1,
    gradeBandColorMap: { [localeCopy.copy_56cbab8f45]: '#f59e0b', [localeCopy.copy_4f5ffea945]: '#10b981', [localeCopy.copy_6de197a041]: '#3b82f6', [localeCopy.copy_c5b6490a3f]: '#ef4444' },

    // Merit list summary (Feature 5)
    meritSummaryGroups: [],
    meritSummaryFilteredGroups: [],
    meritSummaryFilterDept: localeCopy.copy_31d4595959,
    meritSummaryFilterIdent: localeCopy.copy_31d4595959,
    meritSummaryFilterWg: localeCopy.copy_31d4595959,
    meritSummaryDeptOptions: [localeCopy.copy_31d4595959],
    meritSummaryIdentOptions: [localeCopy.copy_31d4595959],
    meritSummaryWgOptions: [localeCopy.copy_31d4595959],
    meritSummaryLoading: false,
    meritSummaryLoaded: false,
    meritSummaryLoadFailed: false,
    expandedMeritSummaryClauseId: ''
  },

  onLoad(options) {
    this._subApp = (options && options.subApp) || 'scoring';
    this._requestedTab = (options && options.tab) || '';
    this.applySubAppFilter();
  },

  onShow() {
    this._pageVisible = true;
    const consumed = orgSession.consume(this);
    const organizationChanged = consumed.changed;
    const preservedTab = this.data.activeTab;
    if (organizationChanged) {
      orgSession.invalidateRequests(this);
      this._bootstrapKey = '';
      this._bootstrapComplete = false;
      this._bootstrapPromise = null;
      this._hrProfileRawRows = [];
      this._hrProfileFilteredRows = [];
      this._hrList = [];
      this.setData({
        activeTab: preservedTab,
        activityList: [],
        currentActivityId: '',
        currentActivityName: '',
        activityForm: emptyActivityForm(),
        templateList: [],
        templateForm: emptyTemplateForm(),
        ruleList: [],
        ruleListView: [],
        selectedRuleIds: [],
        selectedRuleIdMap: {},
        ruleFilters: emptyRuleFilters(),
        ruleForm: emptyRuleForm(),
        publicationList: [],
        publicationForm: { id: '', activityId: '', activityName: '', isPublished: false },
        pubViewRuleList: [],
        pubViewRuleListView: [],
        pubMeritRuleList: [],
        pubMeritRuleListView: [],
        designationList: [],
        publicationAssignmentCandidates: [],
        pubViewRuleFilters: { department: localeCopy.copy_31d4595959, identity: localeCopy.copy_31d4595959 },
        pubMeritRuleFilters: { department: localeCopy.copy_31d4595959, identity: localeCopy.copy_31d4595959 },
        desigSearchKeyword: '',
        meritSummaryGroups: [],
        meritSummaryFilteredGroups: [],
        meritSummaryLoading: false,
        meritSummaryLoaded: false,
        meritSummaryLoadFailed: false,
        hrList: [],
        reactivatingHrId: '',
        hrProfileRows: [],
        hrProfileResultCount: 0,
        hrProfileVisibleCount: 0,
        hrProfileHasMore: false,
        hrProfileFields: [],
        hrProfileTemplateList: [],
        activeHrProfileSnapshot: null,
        showHrTemplateEditor: false,
        hrTemplateSwitchVisible: false,
        hrTemplateSwitchTarget: null,
        hrTemplateSwitchSources: [],
        hrTemplateSwitchToken: '',
        hrTemplateSwitchSummary: null,
        hrProfileFilters: emptyHrProfileFilters(),
        hrProfileFilterOptions: emptyHrProfileFilterOptions(),
        hrProfileActiveFilterChips: [],
        hrProfileSearchFieldIndex: 0,
        hrProfileSortIndex: 0,
        departmentList: [],
        workGroupList: [],
        identityList: [],
        departmentOptions: [],
        workGroupOptions: [],
        identityOptions: [],
        adminList: [],
        adminCandidateKeyword: '',
        adminCandidateList: [],
        dictionaryLoadState: {
          departments: { status: 'idle', message: '' },
          identities: { status: 'idle', message: '' },
          workGroups: { status: 'idle', message: '' }
        },
        dictionaryUsageDialog: {
          visible: false,
          targetName: '',
          usages: []
        },
        resultFilters: emptyResultFilters(),
        resultSearchText: '',
        resultPage: 1,
        recordDetailPopupVisible: false,
        scorerTargetPopupVisible: false,
        showAddEditForm: false,
        showHrPersonDetail: false,
        profileRejectVisible: false,
        profileRejectStudentId: '',
        profileRejectReason: '',
        hrPermanentDeletionVisible: false,
        hrPermanentDeletionTarget: null,
        hrPermanentDeletionPreview: null,
        hrPermanentDeletionResult: null,
        hrPermanentDeletionLoading: false,
        personCorrectionVisible: false,
        personCorrectionPreview: null,
        personCorrectionConfirmed: false,
        personCorrectionProfileValues: {},
        showCsvMappingDialog: false,
        showHrImportPreview: false,
        csvHeaders: [],
        csvRows: [],
        csvColumnMappings: [],
        hrImportPreview: null,
        orgFormVisible: false,
        auditTemplateStepEditorVisible: false,
        auditStepConditionEditorVisible: false,
        auditStarterConditionEditorVisible: false,
        auditMultiPickerVisible: false,
        auditSubmissionDetailVisible: false,
        stampGrantVisible: false,
        stampGrantId: '',
        stampGrantOptions: [],
        stampGrantValue: [],
        stampGrantSaving: false,
        stampGrantError: '',
        stampLoadError: '',
        auditFlowTemplates: [],
        stamps: [],
        auditSubmissions: [],
        verificationPermissions: [],
        loadingMap: {}
      });
      this.clearScoreResultsState();
    }
    // 组织名称必须与本轮统一会话一致，兼容 storage 可能仍在异步落盘。
    const activeOrgId = consumed.snapshot.orgId || '';
    const activeOrgName = consumed.snapshot.orgName || '';
    if (activeOrgId !== this.data.currentOrganizationId
      || (activeOrgName && activeOrgName !== this.data.currentOrganizationName)) {
      this.setData({
        currentOrganizationId: activeOrgId,
        currentOrganizationName: activeOrgName
      });
    }
    // 监听组织切换事件（匹配 portal 页模式）
    if (!this._boundOnOrgChanged) {
      this._boundOnOrgChanged = this._onOrgChanged.bind(this);
      eventBus.on('org:changed', this._boundOnOrgChanged);
    }
    this.bootstrapPage().then(() => {
      if (!orgSession.isCurrent(consumed.snapshot)) return null;
      const activeTab = organizationChanged ? preservedTab : this.data.activeTab;
      if (this._subApp === 'scoring' && ['results', 'publications'].indexOf(activeTab) >= 0) {
        return this._refreshActiveOrganizationTab(activeTab);
      }
      return null;
    });
  },

  onHide() {
    this._pageVisible = false;
    if (this.clearHrInfoKeywordTimer) this.clearHrInfoKeywordTimer();
    // 页面隐藏时移除监听，避免重复注册
    if (this._boundOnOrgChanged) {
      eventBus.off('org:changed', this._boundOnOrgChanged);
      this._boundOnOrgChanged = null;
    }
  },

  onUnload() {
    this._pageVisible = false;
    if (this.clearHrInfoKeywordTimer) this.clearHrInfoKeywordTimer();
    orgSession.invalidateRequests(this);
    if (this._boundOnOrgChanged) {
      eventBus.off('org:changed', this._boundOnOrgChanged);
      this._boundOnOrgChanged = null;
    }
  },

  _onOrgChanged(event) {
    if (!this._pageVisible || !event || event.role !== 'admin') return;
    this.onShow();
  },

  onSystemTimezoneChanged() {
    if (!this._pageVisible) return Promise.resolve();
    if (!this._bootstrapComplete) return Promise.resolve(this.bootstrapPage());
    return this._refreshActiveOrganizationTab(this.data.activeTab);
  },

  async _refreshActiveOrganizationTab(tab) {
    if (['activities', 'rules', 'results', 'publications'].indexOf(tab) >= 0) {
      await this.loadActivityList();
    }
    const loaders = {
      results: () => this.loadScoreResults(),
      hrInfo: () => {
        const loads = [];
        if (this.data.canBrowseHrInfo) loads.push(this.loadHrList(), this.loadHrProfileAdminData());
        else if (this.data.canVerifyIdentity || this.data.canRecoverAccounts || this.data.canGlobalAccountManage) loads.push(this.loadHrGovernanceDirectory());
        return Promise.all(loads);
      },
      hrTemplates: () => this.loadHrProfileTemplates(),
      departments: () => this.loadDepartmentList(),
      workGroups: () => this.loadWorkGroupList(),
      identities: () => this.loadIdentityList(),
      rules: () => this.loadRuleList(),
      activities: () => Promise.resolve(),
      templates: () => this.loadTemplateList(),
      admins: () => this.loadAdminList(),
      settings: () => Promise.all([this.loadSystemConfig(), this.loadOrganizations()]),
      publications: () => {
        const selectedActivityId = String((this.data.publicationForm && this.data.publicationForm.activityId) || '');
        const selectedActivity = (this.data.activityList || []).find((item) => String(item.id || '') === selectedActivityId);
        const activityId = selectedActivity ? selectedActivityId : String(this.data.currentActivityId || '');
        const activityName = selectedActivity ? selectedActivity.name : this.data.currentActivityName;
        if (activityId) {
          this.setData({
            publicationForm: {
              id: '',
              activityId,
              activityName: activityName || '',
              isPublished: false
            }
          });
          return this.loadPublicationData(activityId);
        }
        return this.setData({
          publicationForm: { id: '', activityId: '', activityName: '', isPublished: false },
          publicationList: [],
          pubViewRuleList: [],
          pubViewRuleListView: [],
          pubMeritRuleList: [],
          pubMeritRuleListView: [],
          designationList: [],
          publicationAssignmentCandidates: [],
          meritSummaryGroups: [],
          meritSummaryFilteredGroups: [],
          publicationsLoading: false
        });
      }
    };
    if (loaders[tab]) return Promise.resolve(loaders[tab]());
    return Promise.resolve();
  },

  onOrgTap() {
    const hasUnsavedWork = !!(
      this.data.showAddEditForm || this.data.showCsvMappingDialog || this.data.showHrImportPreview ||
      this.data.orgFormVisible || this.data.auditTemplateStepEditorVisible ||
      this.data.auditStepConditionEditorVisible || this.data.auditStarterConditionEditorVisible ||
      (this.data.ruleForm && (this.data.ruleForm.isRuleClauseEditorVisible || this.data.ruleForm.isTemplateConfigEditorVisible))
    );
    if (hasUnsavedWork) {
      this.setData({ contextSwitchGuardVisible: true });
      return;
    }
    navigateToTrustedRoute('/subpackages/org/pages/identitySwitch/identitySwitch');
  },

  closeContextSwitchGuard() {
    this.setData({ contextSwitchGuardVisible: false });
  },

  showCsvSampleValue(e) {
    const value = e && e.currentTarget && e.currentTarget.dataset
      ? String(e.currentTarget.dataset.value || '')
      : '';
    if (!value) return;
    wx.showModal({
      title: localeCopy.copy_651186ec82,
      content: value,
      showCancel: false,
      confirmText: localeCopy.copy_b722908172
    });
  },

  applySubAppFilter(profileOverride) {
    const subApp = this._subApp || 'scoring';
    const SUB_APP_ADMIN_TABS = {
      scoring: ['activities', 'templates', 'rules', 'results', 'publications'],
      hr: ['hrInfo', 'hrTemplates', 'departments', 'workGroups', 'identities'],
      system: ['admins', 'settings'],
      audit: ['auditTemplates', 'auditStamps', 'auditSubmissions', 'auditVerification']
    };
    const profile = profileOverride || adminPermissions.getAdminProfile();
    this._visibleTabs = adminPermissions.filterTabs(SUB_APP_ADMIN_TABS[subApp] || SUB_APP_ADMIN_TABS.scoring, profile);
    const requestedTab = this._requestedTab;
    const requestedVisible = requestedTab && this._visibleTabs.indexOf(requestedTab) >= 0;
    const SUB_APP_LABELS = { scoring: localeCopy.copy_33a502217d, hr: localeCopy.copy_eb65126cfe, system: localeCopy.copy_5b4cf5d1bf, audit: localeCopy.copy_4f6ab0ccf7 };
    this._subAppLabel = SUB_APP_LABELS[subApp] || '';
    wx.setNavigationBarTitle({
      title: (this._subAppLabel || localeCopy.copy_33a502217d) + localeCopy.copy_61386762d9
    });
    this.setData({
      visibleTabs: this._visibleTabs,
      subAppLabel: this._subAppLabel,
      activeTab: requestedVisible
        ? requestedTab
        : (this._visibleTabs.indexOf(this.data.activeTab) >= 0 ? this.data.activeTab : (this._visibleTabs[0] || ''))
    });
    if (requestedVisible) this._requestedTab = '';
  },

  async bootstrapPage() {
    let adminProfile = authContext.getRuntimeProfile('admin');
    const activeSession = orgSession.getSnapshot();
    const activeRole = activeSession.role || '';

    if (activeRole === 'admin') {
      try {
        // 管理子应用每次新建页面都按服务端当前会话重建角色资料。不能相信
        // 其他分包留下的 profile，即使它非空，也可能仍属于切换前的组织。
        await authContext.refreshCatalog();
      } catch (error) {
        console.error('[admin] restore current user failed:', error.message || error);
      }
      if (!orgSession.isCurrent(activeSession)) return;
      adminProfile = authContext.getRuntimeProfile('admin');
    }

    if (!adminProfile || activeRole !== 'admin') {
      this._visibleTabs = [];
      this.setData({
        user: null,
        hasPermission: false,
        isSuperAdmin: false,
        canManageAdmins: false,
        canReadAdmins: false,
        canWriteAdmins: false
      });
      return;
    }

    try {
      adminProfile = await adminPermissions.refreshMyPermissions() || adminProfile;
    } catch (error) {
      console.error('[admin] refresh permissions failed:', error.message || error);
    }
    if (!orgSession.isCurrent(activeSession)) return;
    adminProfile = authContext.getRuntimeProfile('admin') || adminProfile;
    const isSuperAdmin = !!adminProfile && adminProfile.adminLevel === 'super_admin';
    this.applySubAppFilter(adminProfile);

    const canReadAdmins = adminPermissions.hasAny(adminProfile, [
      'system.admin_accounts.read',
      'system.admin_accounts.write'
    ]);
    const canWriteAdmins = adminPermissions.hasAny(adminProfile, ['system.admin_accounts.write']);
    const canBrowseHrInfo = adminPermissions.hasAny(adminProfile, ['hr.people', 'hr.profile_review']);
    const activeOrgId = activeSession.orgId || '';
    const bootstrapKey = [
      this._subApp || 'scoring',
      activeOrgId,
      activeSession.contextId || '',
      activeSession.version || 0,
      adminProfile.id || '',
      adminProfile.adminLevel || '',
      (adminProfile.permissionKeys || []).slice().sort().join(',')
    ].join('::');

    if (this._bootstrapKey === bootstrapKey && (this._bootstrapComplete || this._bootstrapPromise)) {
      return this._bootstrapPromise;
    }
    this._bootstrapKey = bootstrapKey;
    this._bootstrapComplete = false;

    // 读取当前活跃组织名称
    const activeOrgName = activeSession.orgName || '';

    this.setData({
      user: adminProfile,
      hasPermission: this._visibleTabs.length > 0,
      isSuperAdmin,
      canManageAdmins: canWriteAdmins,
      canReadAdmins,
      canWriteAdmins,
      canExportScoreResults: adminPermissions.hasAny(adminProfile, ['scoring.results_export']),
      canRevokeScoreRecords: adminPermissions.hasAny(adminProfile, ['scoring.results_revoke']),
      canManageHrPeople: adminPermissions.hasAny(adminProfile, ['hr.people']),
      canImportHr: adminPermissions.hasAny(adminProfile, ['hr.import']),
      canReviewHrProfile: adminPermissions.hasAny(adminProfile, ['hr.profile_review']),
      canBrowseHrInfo,
      canManageHrProfileTemplates: adminPermissions.hasAny(adminProfile, ['hr.profile_templates.manage']),
      canSelectHrProfileTemplate: adminPermissions.hasAny(adminProfile, ['hr.profile_templates.select']),
      canVerifyIdentity: adminPermissions.hasAny(adminProfile, ['auth.identity.verify']),
      canRecoverAccounts: adminPermissions.hasAny(adminProfile, ['auth.accounts.recover']),
      canGlobalAccountManage: adminPermissions.hasAny(adminProfile, ['auth.accounts.global_manage']),
      canManageAuthPolicy: adminPermissions.hasAny(adminProfile, ['auth.policy.manage']),
      currentOrganizationId: activeOrgId,
      currentOrganizationName: activeOrgName || this.data.currentOrganizationName,
      resultViewOptions: [
        { value: 'overview', label: localeCopy.copy_a6f7e5f124 },
        { value: 'completion', label: localeCopy.copy_9d954432df }
      ],
      resultViewLabel: localeCopy.copy_a6f7e5f124,
      resultSortOptions: [
        { value: 'score_desc', label: localeCopy.copy_60c630a885 },
        { value: 'name_asc', label: localeCopy.copy_99f2be3030 },
        { value: 'department_asc', label: localeCopy.copy_d379421477 },
        { value: 'workGroup_asc', label: localeCopy.copy_8438adbb77 }
      ],
      resultSortLabel: localeCopy.copy_60c630a885,
      adminLevelOptions: isSuperAdmin ? [localeCopy.copy_fd31650797, localeCopy.copy_ccd219e5f1] : [localeCopy.copy_fd31650797],
      adminLevelValues: isSuperAdmin ? ['admin', 'super_admin'] : ['admin']
    });

    const loadSubApp = async () => {
      const visibleTabs = this._visibleTabs || [];
      if (!visibleTabs.length) return;
      if (this._subApp === 'audit') {
        await Promise.all([
          this.loadDepartmentList(),
          this.loadIdentityList(),
          this.loadHrList()
        ]);
        await this.loadWorkGroupList();
        const auditLoads = [];
        if (visibleTabs.indexOf('auditTemplates') >= 0) auditLoads.push(this.loadAuditFlowTemplates());
        if (visibleTabs.indexOf('auditStamps') >= 0) auditLoads.push(this.loadStamps());
        if (visibleTabs.indexOf('auditSubmissions') >= 0) auditLoads.push(this.loadAuditSubmissions());
        if (visibleTabs.indexOf('auditVerification') >= 0) auditLoads.push(this.loadVerificationPermissions());
        await Promise.all(auditLoads);
        return;
      }

      if (this._subApp === 'hr') {
        const needsHrDirectory = visibleTabs.indexOf('hrInfo') >= 0;
        const canBrowseHr = adminPermissions.hasAny(adminProfile, ['hr.people', 'hr.profile_review']);
        const canGovernHr = adminPermissions.hasAny(adminProfile, ['auth.identity.verify', 'auth.accounts.recover', 'auth.accounts.global_manage']);
        if (needsHrDirectory && canBrowseHr) {
          await Promise.all([this.loadDepartmentList(), this.loadIdentityList()]);
          await this.loadWorkGroupList();
        }
        const canUseTemplates = adminPermissions.hasAny(adminProfile, ['hr.profile_templates.manage', 'hr.profile_templates.select']);
        if (visibleTabs.indexOf('hrInfo') >= 0 && canBrowseHr && !this._csvImportActive && !this.data.showCsvMappingDialog && !this.data.showHrImportPreview) {
          await Promise.all([this.loadHrList(), this.loadHrProfileAdminData()]);
        }
        if (visibleTabs.indexOf('hrInfo') >= 0 && !canBrowseHr && canGovernHr) {
          await this.loadHrGovernanceDirectory();
        }
        if (visibleTabs.indexOf('hrTemplates') >= 0 && canUseTemplates) await this.loadHrProfileTemplates();
        if (visibleTabs.indexOf('hrInfo') >= 0 && this.data.hrInfoMode === 'policy') {
          await this.loadAuthPolicy().catch(() => {});
        }
        this.updateHrFormOptions();
        return;
      }

      if (this._subApp === 'system') {
        const systemLoads = [];
        if (visibleTabs.indexOf('admins') >= 0) {
          systemLoads.push(this.loadAdminList());
          if (canWriteAdmins && adminPermissions.hasAny(adminProfile, ['hr.people'])) {
            systemLoads.push(this.loadHrList());
          }
        }
        if (visibleTabs.indexOf('settings') >= 0) systemLoads.push(this.loadSystemConfig(), this.loadOrganizations());
        await Promise.all(systemLoads);
        return;
      }

      const needsActivity = ['activities', 'rules', 'results', 'publications'].some((tab) => visibleTabs.indexOf(tab) >= 0);
      const scoringLoads = [this.loadDepartmentList(), this.loadIdentityList()];
      if (needsActivity) scoringLoads.push(this.loadActivityList());
      if (visibleTabs.indexOf('templates') >= 0 || visibleTabs.indexOf('rules') >= 0) scoringLoads.push(this.loadTemplateList());
      await Promise.all(scoringLoads);
      await this.loadWorkGroupList();
      if (visibleTabs.indexOf('rules') >= 0) await this.loadRuleList();
    };

    this._bootstrapPromise = loadSubApp()
      .finally(() => {
        if (this._bootstrapKey === bootstrapKey) {
          this._bootstrapComplete = true;
          this._bootstrapPromise = null;
        }
      });
    return this._bootstrapPromise;
  },

  setLoading(key, value) {
    this.setData({
      loadingMap: {
        ...this.data.loadingMap,
        [key]: value
      }
    });
  },

  switchHrInfoMode(e) {
    const mode = String(e.currentTarget.dataset.mode || 'profiles');
    if (mode === this.data.hrInfoMode) return;
    this.setData({ hrInfoMode: mode });
    if (mode === 'policy') {
      this.loadAuthPolicy().catch(() => {
        utils.showShortToast(localeCopy.copy_439c4fcf37);
      });
    } else if (this.data.canBrowseHrInfo) {
      this.loadHrList();
      this.loadHrProfileAdminData();
    } else if (this.data.canVerifyIdentity || this.data.canRecoverAccounts || this.data.canGlobalAccountManage) {
      this.loadHrGovernanceDirectory();
    }
  },

  switchTab(e) {
    const { tab } = e.currentTarget.dataset;
    if (TAB_LIST.indexOf(tab) === -1) {
      return;
    }
    if (this._visibleTabs && this._visibleTabs.indexOf(tab) === -1) {
      return;
    }
    this.setData({ activeTab: tab });
    if (tab === 'results') {
      if (!this.data.currentActivityId) {
        this.loadActivityList().then(() => {
          if (this.data.currentActivityId) {
            this.loadScoreResults();
          } else {
            this.clearScoreResultsState();
          }
        });
      } else {
        this.loadScoreResults({ reuseExisting: true });
      }
    }
    if (tab === 'hrInfo') {
      if (this.data.hrInfoMode === 'policy') {
        this.loadAuthPolicy().catch(() => {
          utils.showShortToast(localeCopy.copy_439c4fcf37);
        });
      } else {
        if (this.data.canBrowseHrInfo && !this._csvImportActive && !this.data.showCsvMappingDialog && !this.data.showHrImportPreview) {
          this.loadHrProfileAdminData();
          this.loadHrList();
        } else if (this.data.canVerifyIdentity || this.data.canRecoverAccounts || this.data.canGlobalAccountManage) {
          this.loadHrGovernanceDirectory();
        }
      }
      this.updateHrFormOptions();
    }
    if (tab === 'hrTemplates') {
      this.loadHrProfileTemplates();
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
    if (tab === 'publications') {
      if (!this.data.departmentList.length) this.loadDepartmentList();
      if (!this.data.identityList.length) this.loadIdentityList();
      this.setData({ publicationsLoading: true });
      this.loadActivityList().then(async () => {
        const selectedActivityId = String((this.data.publicationForm && this.data.publicationForm.activityId) || '');
        const selectedActivity = (this.data.activityList || []).find((item) => String(item.id || '') === selectedActivityId);
        const activityId = selectedActivity ? selectedActivityId : String(this.data.currentActivityId || '');
        const activityName = selectedActivity ? selectedActivity.name : this.data.currentActivityName;
        if (activityId) {
          if (String(this.data.publicationForm.activityId || '') !== activityId) {
            this.setData({
              publicationForm: {
                id: '',
                activityId,
                activityName: activityName || '',
                isPublished: false
              },
              pubViewRuleList: [],
              pubViewRuleListView: [],
              pubMeritRuleList: [],
              pubMeritRuleListView: [],
              designationList: [],
              publicationAssignmentCandidates: [],
              meritSummaryGroups: [],
              meritSummaryFilteredGroups: [],
              meritSummaryLoaded: false,
              meritSummaryLoadFailed: false
            });
          }
          await this.loadPublicationData(activityId);
        }
        this.setData({ publicationsLoading: false });
      }).catch(() => { this.setData({ publicationsLoading: false }); });
    }
    // ── Audit tabs ──
    if (tab === 'auditTemplates') {
      this.loadAuditFlowTemplates();
    }
    if (tab === 'auditStamps') {
      this.loadStamps();
      if (!this.data.identityList.length) this.loadIdentityList();
    }
    if (tab === 'auditSubmissions') {
      this.loadAuditSubmissions();
    }
    if (tab === 'auditVerification') {
      this.loadVerificationPermissions();
    }
  },

  goPortal() {
    wx.redirectTo({
      url: '/subpackages/main/pages/portal/portal'
    });
  },

  wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },

  noop() {},

  async _ensureDepartmentsLoaded() {
    if (this.data.departmentList && this.data.departmentList.length) return;
    const result = await this.callCloud('listDepartments');
    if (result.status === 'success') {
      this.setData({ departmentList: result.departments || [] });
    }
  },

  async _ensureIdentitiesLoaded() {
    if (this.data.identityList && this.data.identityList.length) return;
    const result = await this.callCloud('listIdentities');
    if (result.status === 'success') {
      this.setData({ identityList: result.identities || [] });
    }
  },

  async _ensureWorkGroupsLoaded() {
    if (this.data.workGroupList && this.data.workGroupList.length) return;
    const result = await this.callCloud('listWorkGroups');
    if (result.status === 'success') {
      const items = (result.workGroups || []).map((item) => {
        const department = this.data.departmentList.find(d => (
          d.id === item.departmentId || d.code === item.departmentCode
        ));
        return {
          ...item,
          departmentCode: item.departmentCode || (department ? department.code : ''),
          departmentName: item.departmentName || (department ? department.name : '')
        };
      });
      this.setData({ workGroupList: items });
    }
  },

  updateDetailWorkGroupOptions(deptId) {
    const id = deptId || this.data.detailHrValues._departmentId || (this.data.detailHrProfile || {}).departmentId || '';
    if (!id) {
      this.setData({ detailWorkGroupOptions: [localeCopy.copy_54e953f1bb], detailWorkGroupValue: 0 });
      return;
    }
    const idStr = String(id);
    const wgs = this.data.workGroupList
      .filter(w => String(w.departmentId) === idStr)
      .map(w => w.name);
    const options = [localeCopy.copy_54e953f1bb, ...wgs];
    const wgName = this.data.detailHrValues._workGroupName || '';
    const wgIdx = options.indexOf(wgName);
    this.setData({
      detailWorkGroupOptions: options,
      detailWorkGroupValue: wgIdx >= 0 ? wgIdx : 0
    });
  },

  _ensureDetailFormOptions() {
    this.setData({
      departmentOptions: this.data.departmentList.map(item => item.name),
      identityOptions: this.data.identityList.map(item => item.name)
    });
  },

  _syncDetailPickerValues() {
    const vals = this.data.detailHrValues || {};
    const deptValue = this.data.departmentOptions.indexOf(vals._departmentName);
    const identityValue = this.data.identityOptions.indexOf(vals._identityName);

    const fieldValues = { ...(this.data.detailFieldValues || {}) };
    const template = this.data.detailHrTemplate;
    if (template && template.fields) {
      template.fields.forEach(f => {
        if (f.type === 'sequence' && Array.isArray(f.options)) {
          const idx = f.options.indexOf(vals[f.id]);
          fieldValues[f.id] = idx >= 0 ? idx : 0;
        }
      });
    }

    this.setData({
      detailDepartmentValue: deptValue >= 0 ? deptValue : 0,
      detailIdentityValue: identityValue >= 0 ? identityValue : 0,
      detailFieldValues: fieldValues
    });
  },

  escapeCsvCell(value) {
    let s = String(value == null ? '' : value);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
});
