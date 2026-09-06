const localeCopy = require('../../../../locales/zh-CN/generated/subpackages/audit/pages/submissionDetail/submissionDetail');
const { callFunction, getErrorText, showShortToast, formatAuditTime, formatAuditDetailTime } = require('../../../../utils/api');
const { openAuditFile } = require('../../../../utils/filePreview');
const orgSession = require('../../../../utils/orgSession');
const { formatAbsoluteDate } = require('../../../../utils/dateTime');
const authContext = require('../../../../utils/authContext');
const { navigateToTrustedRoute } = require('../../../../utils/trustedNavigation');
const workContextView = require('../../utils/workContextView');
const { calculateWorkflowProgress } = require('../../utils/workflowProgress');

const AUDIT_ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const AUDIT_MAX_FILE_SIZE = 10 * 1024 * 1024;

function normalizeApprovalActionTypeForView(value) {
  return value === 'stamp' ? 'estamp' : (value || 'pass');
}

function normalizeApprovalStepForView(step) {
  return Object.assign({}, step || {}, {
    actionType: normalizeApprovalActionTypeForView(step && step.actionType)
  });
}

Page({
  data: {
    localeCopy,
    submissionId: '',
    action: '', // 'create' or 'view'
    submission: null,
    steps: [],  // kept for backward compat; prefer flowTimeline
    flowTimeline: [],
    files: [],
    signatures: [],
    loading: false,
    flowProgressPercent: 0,
    flowProgressText: localeCopy.copy_cbacf49da2,

    // Create mode
    createMode: 'template', // 'template' or 'ad_hoc'
    flowTemplates: [],
    selectedTemplateId: '',
    createTitle: '',
    createDesc: '',
    uploadedFiles: [], // { fileId, fileName, mimeType, fileSize, fileHash, tmpPath }
    adHocSteps: [],
    adHocStepForm: { name: '', approverType: 'identity', approverIdentityId: '', approverIdentityName: '', approverHrId: '', approverHrName: '', actionType: 'pass', scopeType: 'all', scopeDepartmentId: '', scopeDepartmentName: '', scopeWorkGroupId: '', scopeWorkGroupName: '' },
    adHocStepEditorVisible: false,
    resubmitMode: 'fresh',

    // Reference data for approver picker
    allDepartments: [],
    allIdentities: [],
    allWorkGroups: [],
    allHrPersons: [],

    // Approver picker — identity mode
    identityPickerScopeIndex: 0,
    identityPickerScopeOptions: [localeCopy.copy_76d431a4dc, localeCopy.copy_4cecd19152, localeCopy.copy_b3cdc001ce, localeCopy.copy_17f5307ade, localeCopy.copy_5c499d7608],
    identityPickerScopeValues: ['all', 'same_department', 'same_work_group', 'specific_department', 'specific_work_group'],
    identityPickerDeptIndex: 0,
    identityPickerDeptOptions: [localeCopy.copy_68f7277730],
    identityPickerWgIndex: 0,
    identityPickerWgOptions: [localeCopy.copy_e986e973a2],
    identityPickerIdentIndex: 0,
    identityPickerIdentOptions: [localeCopy.copy_55780718f9],

    // Template step preview (for overrides)
    templatePreviewSteps: [],
    templateStepOverrides: [],    // [{ stepIndex, personHrIds: [], assignmentIds: [], assignmentViews: [] }]
    templateOverrideStepIndex: -1, // which step index is being edited in person picker

    // Approver picker — person mode (multi-select)
    personPickerVisible: false,
    personPickerDept: localeCopy.copy_31d4595959,
    personPickerIdent: localeCopy.copy_31d4595959,
    personPickerWg: localeCopy.copy_31d4595959,
    personPickerDeptOpts: [localeCopy.copy_31d4595959],
    personPickerIdentOpts: [localeCopy.copy_31d4595959],
    personPickerWgOpts: [localeCopy.copy_31d4595959],
    personPickerKeyword: '',
    personPickerCandidates: [],
    personPickerSelectedIds: [],
    personPickerSelectedList: [],
    personPickerStepActionType: 'sign',
    personPickerMode: '',  // '' | 'designateNext'
    personPickerEligibleList: [],  // API-loaded eligible approvers for current step
    personPickerLoading: false,

    // Edit mode (for editable submissions)
    editMode: false,
    editTitle: '',
    editDesc: '',
    editType: '',        // 'template' or 'ad_hoc'
    editResubmitMode: 'fresh',
    editTemplateId: '',
    editSteps: [],       // for ad_hoc type
    editFiles: [],       // current files (display)
    editNewFiles: [],    // newly uploaded files
    editStepEditorVisible: false,
    editStepForm: { name: '', approverType: 'identity', approverIdentityId: '', approverIdentityName: '', approverHrId: '', approverHrName: '', actionType: 'pass', scopeType: 'all', scopeDepartmentId: '', scopeDepartmentName: '', scopeWorkGroupId: '', scopeWorkGroupName: '' },
    editIdentityPickerScopeIndex: 0,
    editIdentityPickerDeptIndex: 0,
    editIdentityPickerWgIndex: 0,
    editIdentityPickerIdentIndex: 0,
    editPersonPickerVisible: false,
    editPersonPickerDept: localeCopy.copy_31d4595959,
    editPersonPickerIdent: localeCopy.copy_31d4595959,
    editPersonPickerWg: localeCopy.copy_31d4595959,
    editPersonPickerKeyword: '',
    editPersonPickerCandidates: [],
    editPersonPickerSelectedIds: [],
    editPersonPickerSelectedList: [],
    editPersonPickerStepActionType: 'pass',
    editPersonPickerLoading: false,
    editUploading: false,

    // Approval mode
    approvalVisible: false,
    approvalStepId: '',
    approvalAction: '', // 'approve' or 'reject'
    approvalComment: '',
    rejectionReason: '',
    signaturePadVisible: false,
    currentSignatureFileId: '',
    pendingSignatures: [], // signatures to submit with approval

    // Inline approval card
    activeApprovalStepId: '',
    activeApprovalStep: null,
    designatedNextPersons: [], // [{id, name}] for next-step designation
    nextStepInfo: null,        // {sortOrder, approverDesc} of next step
    approvalWarning: '',       // warning text for incomplete sign+stamp

    // Stamp picker
    stampPickerVisible: false,
    availableStamps: [],
    stampPickFileId: '',
    stampPickFileName: '',

    // Signature source picker (saved sigs + new drawing + save option)
    sigSourcePickerVisible: false,
    sigSourceFileId: '',
    sigSourceFileName: '',
    mySignatures: [],
    sigSaveNew: false,
    sigSaveName: '',

    // Placement / File Preview popup (positioning sig/stamp on file)
    placementVisible: false,
    placementType: '',        // 'signature' or 'stamp'
    placementFileName: '',
    placementFileImage: '',   // base64 image data for preview (with data URI prefix)
    placementItems: [],       // all sigs/stamps on the current file
    placementActiveIdx: -1,   // index of the item being repositioned
    placementPreviewX: -1,    // preview crosshair X (0-1)
    placementPreviewY: -1,    // preview crosshair Y (0-1)
    placementFileId: '',
    placementFileMime: '',       // mime type of the file being previewed
    placementTotalPages: 1,      // total pages (for PDFs)
    placementCurrentPage: 1,     // current page being shown
    placementLoading: false,     // loading page preview
    placementPosText: '',        // formatted position text for display
    placementCanvasMaxHeight: 300, // computed max canvas height in px
    placementSize: 100,          // selected signature/stamp size percentage
    placementRotation: 0,        // selected signature/stamp rotation degrees
    placementAutoOpened: false,  // true = placement was auto-opened for a new sig; cancel removes it

    // User role flags
    userIsSubmitter: false,
    userIsApprover: false,
    userIsAdmin: false,
    activeWorkContext: null,
    hasActiveAssignment: false,

    // Flow node expansion
    expandedNodeKey: '',

    // Uploading
    uploading: false
  },

  // Empty handler for catchtap to prevent event bubbling through popups
  noop() {},

  refreshActiveWorkContext() {
    const snapshot = orgSession.getSnapshot();
    const profile = authContext.getRuntimeProfile(snapshot.role) || {};
    const current = workContextView.normalizeCurrentWorkContext(
      authContext.getWorkContexts(),
      authContext.getSelection(),
      profile
    );
    this.setData({
      activeWorkContext: current,
      hasActiveAssignment: current.hasAssignment
    });
    return current;
  },

  goWorkContextSwitch() {
    navigateToTrustedRoute('/subpackages/org/pages/identitySwitch/identitySwitch');
  },

  showWorkContextGuide(message) {
    const that = this;
    wx.showModal({
      title: localeCopy.workContextRequiredTitle,
      content: message || localeCopy.workContextRequiredDescription,
      confirmText: localeCopy.switchWorkContext,
      cancelText: localeCopy.copy_06dbb49961,
      success(result) {
        if (result.confirm) that.goWorkContextSwitch();
      }
    });
  },

  ensureActiveAssignment() {
    const current = this.refreshActiveWorkContext();
    if (current.hasAssignment) return true;
    this.showWorkContextGuide(localeCopy.noAssignmentActionDescription);
    return false;
  },

  handleWorkContextFailure(result) {
    if (!workContextView.isContextFailure(result)) return false;
    this.showWorkContextGuide(localeCopy.workContextMismatchDescription);
    return true;
  },

  onLoad(options) {
    wx.setNavigationBarTitle({ title: localeCopy.navigationTitle });
    this._pageActive = true;
    orgSession.consume(this);
    this.refreshActiveWorkContext();
    if (options.action === 'create') {
      this.setData({ action: 'create' });
      if (this.data.hasActiveAssignment) {
        this.loadFlowTemplates();
        this.loadReferenceData();
      }
    } else if (options.id) {
      this.setData({ submissionId: options.id, action: 'view' });
      this.loadDetail();
      this.loadReferenceData();  // Load dept/ident/wg opts for person picker filters
    }
  },

  onShow() {
    this._pageActive = true;
    if (!orgSession.consume(this).changed) {
      this.refreshActiveWorkContext();
      return;
    }
    orgSession.invalidateRequests(this);
    showShortToast(localeCopy.copy_d86124b728);
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/subpackages/main/pages/portal/portal' }) });
  },

  onHide() {
    this._pageActive = false;
    if (this._actionTimer) {
      clearTimeout(this._actionTimer);
      this._actionTimer = null;
    }
  },

  onUnload() {
    this._pageActive = false;
    orgSession.invalidateRequests(this);
    if (this._actionTimer) {
      clearTimeout(this._actionTimer);
      this._actionTimer = null;
    }
  },

  // ═══════════════════════════════════════════════
  // Reference Data Loading
  // ═══════════════════════════════════════════════

  async loadReferenceData() {
    try {
      const safeCall = promise => promise.catch(() => ({ status: 'error' }));
      const [deptRes, identRes, wgRes] = await Promise.all([
        safeCall(callFunction({ name: 'listDepartments', data: {} })),
        safeCall(callFunction({ name: 'listIdentities', data: {} })),
        safeCall(callFunction({ name: 'listWorkGroups', data: {} }))
      ]);

      const departments = (deptRes.status === 'success' ? deptRes.departments : []) || [];
      const identities = (identRes.status === 'success' ? identRes.identities : []) || [];
      const workGroups = (wgRes.status === 'success' ? wgRes.workGroups : []) || [];

      const deptNames = [...new Set(departments.map(d => d.name).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      const identNames = [...new Set(identities.map(i => i.name).filter(Boolean))];
      const wgNames = [...new Set(workGroups.map(w => w.name).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));

      this.setData({
        allDepartments: departments,
        allIdentities: identities,
        allWorkGroups: workGroups,
        identityPickerDeptOptions: [localeCopy.copy_68f7277730, ...deptNames],
        identityPickerWgOptions: [localeCopy.copy_e986e973a2, ...wgNames],
        identityPickerIdentOptions: [localeCopy.copy_55780718f9, ...identNames],
        personPickerDeptOpts: [localeCopy.copy_31d4595959, ...deptNames],
        personPickerIdentOpts: [localeCopy.copy_31d4595959, ...identNames],
        personPickerWgOpts: [localeCopy.copy_31d4595959, ...wgNames]
      });
    } catch (e) {
      // Non-fatal; picker will just show fewer options
    }
  },

  onSystemTimezoneChanged() {
    if (!this._pageActive || this.data.action !== 'view' || !this.data.submissionId) return;
    return this.loadDetail();
  },

  _normalizeApproverList(list) {
    const activeAssignmentId = this.data.activeWorkContext
      ? this.data.activeWorkContext.assignmentId
      : '';
    return (Array.isArray(list) ? list : []).map(function(person) {
      return workContextView.normalizeCandidate(person, activeAssignmentId);
    }).filter(function(person) { return person.id; });
  },

  _selectedAssignmentViews(persons, selectedAssignmentIds) {
    return workContextView.selectedAssignmentViews(
      persons,
      selectedAssignmentIds,
      localeCopy.assignmentLabelUnavailable
    );
  },

  _decorateAssignmentSelection(persons, selectedAssignmentIds) {
    return workContextView.decorateAssignmentSelection(persons, selectedAssignmentIds);
  },

  _updatePersonPickerOptions(list) {
    const persons = Array.isArray(list) ? list : [];
    const departments = persons.reduce(function(values, person) {
      return values.concat(person.eligibleDepartments || []);
    }, []);
    const identities = persons.reduce(function(values, person) {
      return values.concat(person.eligibleIdentityCategories || []);
    }, []);
    const workGroups = persons.reduce(function(values, person) {
      return values.concat(person.eligibleWorkGroups || []);
    }, []);
    const unique = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    this.setData({
      personPickerDeptOpts: [localeCopy.copy_31d4595959, ...unique(departments)],
      personPickerIdentOpts: [localeCopy.copy_31d4595959, ...unique(identities)],
      personPickerWgOpts: [localeCopy.copy_31d4595959, ...unique(workGroups)]
    });
  },

  // ═══════════════════════════════════════════════
  // Create Mode
  // ═══════════════════════════════════════════════

  async loadFlowTemplates() {
    try {
      const res = await callFunction({ name: 'listAvailableFlowTemplates', data: {} });
      if (res.status === 'success') {
        this.setData({ flowTemplates: res.templates || [] });
      }
    } catch (e) {
      showShortToast(getErrorText(e, localeCopy.copy_fbc220bedd));
    }
  },

  onTemplateSelect(e) {
    let id = e.currentTarget.dataset.id;
    // Toggle: tap selected item to deselect
    let newId = this.data.selectedTemplateId === id ? '' : id;
    this.setData({
      selectedTemplateId: newId,
      templatePreviewSteps: [],
      templateStepOverrides: []
    });
    if (newId) {
      this.loadTemplatePreview(newId);
    }
  },

  // Load template steps preview for step-level person override
  async loadTemplatePreview(templateId, existingOverrides) {
    try {
      let res = await callFunction({ name: 'previewTemplateSteps', data: { templateId: templateId } });
      if (res.status === 'success') {
        let steps = (res.steps || []).map(normalizeApprovalStepForView);
        // The submitter may only designate the first step when that step allows it.
        const previousOverrides = Array.isArray(existingOverrides) ? existingOverrides : [];
        let overrides = steps.filter(function(s) {
          return Number(s.stepIndex) === 1 && s.allowApproverDesignation === true;
        }).map(function(s) {
          const previous = previousOverrides.find(function(o) {
            return Number(o.stepIndex) === Number(s.stepIndex);
          });
          return {
            stepIndex: s.stepIndex,
            personHrIds: previous && Array.isArray(previous.personHrIds) ? previous.personHrIds.slice() : [],
            personHrNames: previous && Array.isArray(previous.personHrNames) ? previous.personHrNames.slice() : [],
            assignmentIds: previous && Array.isArray(previous.assignmentIds) ? previous.assignmentIds.slice() : [],
            assignmentViews: previous && Array.isArray(previous.assignmentViews) ? previous.assignmentViews.slice() : []
          };
        });
        this.setData({
          templatePreviewSteps: steps,
          templateStepOverrides: overrides
        });
      }
    } catch (e) {
      console.error('[audit] loadTemplatePreview failed:', e);
      showShortToast(localeCopy.copy_3a89b81529);
    }
  },

  // Open person picker for a specific template step override
  async openTemplateStepPersonPicker(e) {
    if (!this.ensureActiveAssignment()) return;
    let stepIndex = parseInt(e.currentTarget.dataset.stepIndex);
    let targetStep = (this.data.templatePreviewSteps || []).find(function(s) {
      return Number(s.stepIndex) === stepIndex;
    });
    const templateId = this.data.editMode ? this.data.editTemplateId : this.data.selectedTemplateId;
    if (stepIndex !== 1 || !templateId || !targetStep || targetStep.allowApproverDesignation !== true) {
      showShortToast(localeCopy.copy_2758c01952);
      return;
    }

    this.setData({
      personPickerVisible: true,
      personPickerLoading: true,
      personPickerMode: '',
      templateOverrideStepIndex: stepIndex,
      personPickerDept: localeCopy.copy_31d4595959,
      personPickerIdent: localeCopy.copy_31d4595959,
      personPickerWg: localeCopy.copy_31d4595959,
      personPickerKeyword: '',
      personPickerSelectedIds: [],
      personPickerSelectedList: [],
      personPickerStepActionType: 'pass'
    });

    // Load eligible approvers from server (stepIndex is 1-based in UI)
    let eligibleList = [];
    try {
      let res = await callFunction({
        name: 'listEligibleApprovers',
        data: {
          templateId: templateId,
          stepIndex: stepIndex,
          editSubmissionId: this.data.editMode ? this.data.submissionId : ''
        }
      });
      if (res.status === 'success') {
        eligibleList = this._normalizeApproverList(res.approvers || []);
      } else {
        this.handleWorkContextFailure(res);
      }
    } catch (err) {
      console.error('[audit] listEligibleApprovers (template) failed:', err);
    }
    this._updatePersonPickerOptions(eligibleList);

    // 预填必须使用岗位 ID；人员 ID 只作为岗位归属校验的伴随字段。
    let entry = (this.data.templateStepOverrides || []).find(function(o) { return o.stepIndex === stepIndex; });
    let preSelectedIds = [];
    let preSelectedList = [];
    if (entry && entry.assignmentIds && entry.assignmentIds.length) {
      preSelectedIds = entry.assignmentIds.slice();
      preSelectedList = this._selectedAssignmentViews(eligibleList, preSelectedIds);
    }
    this.setData({
      personPickerEligibleList: eligibleList,
      personPickerLoading: false,
      personPickerVisible: true,
      personPickerMode: '',
      templateOverrideStepIndex: stepIndex,
      personPickerDept: localeCopy.copy_31d4595959,
      personPickerIdent: localeCopy.copy_31d4595959,
      personPickerWg: localeCopy.copy_31d4595959,
      personPickerKeyword: '',
      personPickerSelectedIds: preSelectedIds,
      personPickerSelectedList: preSelectedList,
      personPickerStepActionType: 'pass'
    });
    this.applyPersonPickerFilters();
  },

  // Confirm person picker for template step override
  confirmTemplateStepPersonPicker() {
    let selected = this.data.personPickerSelectedList;
    let stepIndex = this.data.templateOverrideStepIndex;
    if (stepIndex < 0) return;
    let overrides = [...this.data.templateStepOverrides];
    let entry = overrides.find(function(o) { return o.stepIndex === stepIndex; });
    if (!entry) {
      entry = { stepIndex: stepIndex, personHrIds: [], personHrNames: [], assignmentIds: [], assignmentViews: [] };
      overrides.push(entry);
    }
    entry.personHrIds = [...new Set(selected.map(function(p) { return p.id; }))];
    entry.personHrNames = selected.map(function(p) { return p.name; });
    entry.assignmentIds = selected.map(function(p) { return p.assignmentId; });
    entry.assignmentViews = selected.slice();
    this.setData({
      templateStepOverrides: overrides,
      personPickerVisible: false,
      personPickerLoading: false,
      personPickerMode: '',
      templateOverrideStepIndex: -1
    });
  },

  // Remove a person from a template step override
  removeTemplateStepOverridePerson(e) {
    let stepIndex = parseInt(e.currentTarget.dataset.stepIndex);
    let assignmentId = e.currentTarget.dataset.assignmentId;
    let overrides = [...this.data.templateStepOverrides];
    let entry = overrides.find(function(o) { return o.stepIndex === stepIndex; });
    if (entry) {
      let idx = (entry.assignmentIds || []).indexOf(assignmentId);
      if (idx >= 0) {
        entry.assignmentIds.splice(idx, 1);
        entry.personHrNames.splice(idx, 1);
        entry.assignmentViews.splice(idx, 1);
        entry.personHrIds = [...new Set(entry.assignmentViews.map(function(item) { return item.id; }))];
      }
    }
    this.setData({ templateStepOverrides: overrides });
  },

  onCreateModeChange(e) {
    this.setData({ createMode: e.currentTarget.dataset.mode });
  },

  onResubmitModeChange(e) {
    this.setData({ resubmitMode: ['fresh', 'from_rejector'][e.detail.value] || 'fresh' });
  },

  onTitleInput(e) {
    this.setData({ createTitle: e.detail.value });
  },

  onDescInput(e) {
    this.setData({ createDesc: e.detail.value });
  },

  // ── Ad-hoc Step Editor ──

  openAdHocStepEditor() {
    this.setData({
      adHocStepEditorVisible: true,
      adHocStepForm: { name: '', approverType: 'identity', approverIdentityId: '', approverIdentityName: '', approverHrId: '', approverHrName: '', actionType: 'pass', scopeType: 'all', scopeDepartmentId: '', scopeDepartmentName: '', scopeWorkGroupId: '', scopeWorkGroupName: '' },
      identityPickerScopeIndex: 0,
      identityPickerDeptIndex: 0,
      identityPickerWgIndex: 0,
      identityPickerIdentIndex: 0
    });
  },

  closeAdHocStepEditor() {
    this.setData({ adHocStepEditorVisible: false, personPickerVisible: false });
  },

  onAdHocStepField(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['adHocStepForm.' + field]: e.detail.value });
  },

  onAdHocStepTypeChange(e) {
    const type = ['identity', 'specific_person'][e.detail.value] || 'identity';
    this.setData({
      'adHocStepForm.approverType': type,
      'adHocStepForm.approverIdentityId': '',
      'adHocStepForm.approverIdentityName': '',
      'adHocStepForm.approverHrId': '',
      'adHocStepForm.approverHrName': ''
    });
  },

  onAdHocActionTypeChange(e) {
    const val = ['pass', 'sign', 'estamp', 'both'][e.detail.value] || 'pass';
    this.setData({ 'adHocStepForm.actionType': val });
  },

  // ── Identity mode picker ──

  onIdentityScopeChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({ identityPickerScopeIndex: idx });
  },

  onIdentityDeptChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({ identityPickerDeptIndex: idx });
  },

  onIdentityWgChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({ identityPickerWgIndex: idx });
  },

  onIdentityIdentChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({ identityPickerIdentIndex: idx });
  },

  // ── Person picker popup (multi-select) ──

  async openPersonPicker() {
    if (!this.ensureActiveAssignment()) return;
    // 先打开弹窗，再异步加载当前组织内可指定的完整人员目录。
    this.setData({
      personPickerVisible: true,
      personPickerLoading: true,
      personPickerMode: '',
      templateOverrideStepIndex: -1,
      personPickerDept: localeCopy.copy_31d4595959,
      personPickerIdent: localeCopy.copy_31d4595959,
      personPickerWg: localeCopy.copy_31d4595959,
      personPickerKeyword: '',
      personPickerSelectedIds: [],
      personPickerSelectedList: [],
      personPickerStepActionType: 'pass'
    });

    let eligibleList = [];
    try {
      const res = await callFunction({ name: 'listEligibleApprovers', data: { all: true } });
      if (res.status === 'success') {
        eligibleList = this._normalizeApproverList(res.approvers || []);
      } else {
        this.handleWorkContextFailure(res);
      }
    } catch (error) {
      console.error('[audit] listEligibleApprovers (ad hoc) failed:', error);
    }
    this._updatePersonPickerOptions(eligibleList);
    this.setData({
      personPickerEligibleList: eligibleList,
      personPickerLoading: false
    });
    this.applyPersonPickerFilters();
  },

  closePersonPicker() {
    this.setData({ personPickerVisible: false, personPickerLoading: false, personPickerMode: '', templateOverrideStepIndex: -1 });
  },

  confirmSharedPersonPicker(e) {
    const detail = e.detail || {};
    this.setData({
      personPickerSelectedIds: Array.isArray(detail.keys) ? detail.keys : [],
      personPickerSelectedList: Array.isArray(detail.items) ? detail.items : []
    }, () => this.confirmPersonPicker());
  },

  onPersonPickerDeptChange(e) {
    const opts = this.data.personPickerDeptOpts;
    this.setData({ personPickerDept: opts[parseInt(e.detail.value)] || localeCopy.copy_31d4595959 });
    this.applyPersonPickerFilters();
  },

  onPersonPickerIdentChange(e) {
    const opts = this.data.personPickerIdentOpts;
    this.setData({ personPickerIdent: opts[parseInt(e.detail.value)] || localeCopy.copy_31d4595959 });
    this.applyPersonPickerFilters();
  },

  onPersonPickerWgChange(e) {
    const opts = this.data.personPickerWgOpts;
    this.setData({ personPickerWg: opts[parseInt(e.detail.value)] || localeCopy.copy_31d4595959 });
    this.applyPersonPickerFilters();
  },

  onPersonPickerSearch(e) {
    this.setData({ personPickerKeyword: e.detail.value });
    this.applyPersonPickerFilters();
  },

  applyPersonPickerFilters() {
    let list = [...this.data.personPickerEligibleList];
    const dept = this.data.personPickerDept;
    const ident = this.data.personPickerIdent;
    const wg = this.data.personPickerWg;
    const kw = (this.data.personPickerKeyword || '').trim().toLowerCase();

    list = list.map(function(person) {
      return workContextView.filterCandidateAssignments(person, {
        department: dept === localeCopy.copy_31d4595959 ? '' : dept,
        identityCategory: ident === localeCopy.copy_31d4595959 ? '' : ident,
        workGroup: wg === localeCopy.copy_31d4595959 ? '' : wg,
        keyword: kw
      });
    }).filter(Boolean);

    const selectedIds = this.data.personPickerSelectedIds;
    const candidates = this._decorateAssignmentSelection(list, selectedIds);
    const selectedList = this._selectedAssignmentViews(this.data.personPickerEligibleList, selectedIds);

    this.setData({
      personPickerCandidates: candidates,
      personPickerSelectedList: selectedList
    });
  },

  onPersonToggle(e) {
    const assignmentId = String(e.currentTarget.dataset.assignmentId || '');
    if (!assignmentId) return;
    let sel = [...this.data.personPickerSelectedIds];
    const idx = sel.indexOf(assignmentId);
    if (idx >= 0) sel.splice(idx, 1); else sel.push(assignmentId);
    this.setData({ personPickerSelectedIds: sel });
    this.applyPersonPickerFilters();
  },

  onPersonPickerActionTypeChange(e) {
    this.setData({ personPickerStepActionType: ['pass', 'sign', 'estamp', 'both'][e.detail.value] || 'pass' });
  },

  confirmPersonPicker() {
    // If we're in template step override mode, delegate
    if (this.data.templateOverrideStepIndex >= 0) {
      this.confirmTemplateStepPersonPicker();
      return;
    }

    // If we're in next-step designation mode, save to designatedNextPersons
    if (this.data.personPickerMode === 'designateNext') {
      let designatedList = this.data.personPickerSelectedList;
      this.setData({
        designatedNextPersons: designatedList.slice(),
        personPickerVisible: false,
        personPickerMode: ''
      });
      return;
    }

    const selected = this.data.personPickerSelectedList;
    if (!selected.length) {
      showShortToast(localeCopy.copy_b66608a15f);
      return;
    }

    const steps = [...this.data.adHocSteps];
    const actionType = this.data.personPickerStepActionType;
    for (const p of selected) {
      steps.push({
        name: (this.data.adHocStepForm.name || '').trim() || (p.name + localeCopy.copy_c9695bb971),
        approverType: 'specific_person',
        approverHrId: p.id,
        approverHrName: p.name,
        approverAssignmentId: p.assignmentId,
        approverAssignmentLabel: p.assignmentLabel,
        approverDesc: p.name + ' · ' + p.assignmentLabel,
        approverIdentityId: '',
        approverIdentityName: '',
        actionType,
        conditions: [{
          conditionType: 'person',
          personHrIds: p.id,
          assignmentIds: p.assignmentId
        }]
      });
    }

    this.setData({
      adHocSteps: steps,
      personPickerVisible: false
    });
  },

  // ── Confirm single identity step ──

  confirmAdHocStep() {
    const sf = this.data.adHocStepForm;
    const identities = this.data.allIdentities;
    const departments = this.data.allDepartments;
    const workGroups = this.data.allWorkGroups;

    // Resolve identity from picker
    const identIdx = this.data.identityPickerIdentIndex;
    const identOpts = this.data.identityPickerIdentOptions;

    if (identIdx <= 0) {
      showShortToast(localeCopy.copy_d1856227b6);
      return;
    }

    const identName = identOpts[identIdx];
    const identity = identities.find(i => i.name === identName);
    if (!identity) {
      showShortToast(localeCopy.copy_10d3269bb4);
      return;
    }

    // Resolve scope
    const scopeIdx = this.data.identityPickerScopeIndex;
    const scopeValues = this.data.identityPickerScopeValues;
    const scopeType = scopeValues[scopeIdx] || 'all';

    let scopeDepartmentId = '';
    let scopeDepartmentName = '';
    let scopeWorkGroupId = '';
    let scopeWorkGroupName = '';

    if (scopeType === 'specific_department' || scopeType === 'specific_work_group') {
      const deptIdx = this.data.identityPickerDeptIndex;
      const deptOpts = this.data.identityPickerDeptOptions;
      if (deptIdx <= 0) {
        showShortToast(localeCopy.copy_eada426deb);
        return;
      }
      const deptName = deptOpts[deptIdx];
      const dept = departments.find(d => d.name === deptName);
      if (!dept) { showShortToast(localeCopy.copy_9f09d6a2b3); return; }
      scopeDepartmentId = dept.id;
      scopeDepartmentName = dept.name;
    }

    if (scopeType === 'specific_work_group') {
      const wgIdx = this.data.identityPickerWgIndex;
      const wgOpts = this.data.identityPickerWgOptions;
      if (wgIdx <= 0) {
        showShortToast(localeCopy.copy_ec3b03ecc7);
        return;
      }
      const wgName = wgOpts[wgIdx];
      const wg = workGroups.find(w => w.name === wgName);
      if (!wg) { showShortToast(localeCopy.copy_c4f6a0088b); return; }
      scopeWorkGroupId = wg.id;
      scopeWorkGroupName = wg.name;
    }

    const steps = [...this.data.adHocSteps];
    steps.push({
      name: (sf.name || '').trim(),
      approverType: 'identity',
      approverIdentityId: identity.id,
      approverIdentityName: identity.name,
      approverHrId: '',
      approverHrName: '',
      actionType: sf.actionType,
      scopeType: scopeType,
      scopeDepartmentId: scopeDepartmentId,
      scopeDepartmentName: scopeDepartmentName,
      scopeWorkGroupId: scopeWorkGroupId,
      scopeWorkGroupName: scopeWorkGroupName
    });

    this.setData({
      adHocSteps: steps,
      adHocStepForm: { name: '', approverType: 'identity', approverIdentityId: '', approverIdentityName: '', approverHrId: '', approverHrName: '', actionType: 'pass', scopeType: 'all', scopeDepartmentId: '', scopeDepartmentName: '', scopeWorkGroupId: '', scopeWorkGroupName: '' },
      adHocStepEditorVisible: false,
      identityPickerScopeIndex: 0,
      identityPickerDeptIndex: 0,
      identityPickerWgIndex: 0,
      identityPickerIdentIndex: 0
    });
  },

  removeAdHocStep(e) {
    const idx = e.currentTarget.dataset.index;
    const steps = [...this.data.adHocSteps];
    steps.splice(idx, 1);
    this.setData({ adHocSteps: steps });
  },

  // ── Helpers for step display ──

  getApproverLabel(step) {
    if (step.approverType === 'specific_person' && step.approverHrName) {
      return step.approverHrName;
    }
    if (step.approverIdentityName) {
      return step.approverIdentityName;
    }
    if (step.approverIdentityId) {
      const ident = this.data.allIdentities.find(i => i.id === step.approverIdentityId);
      return ident ? ident.name : step.approverIdentityId;
    }
    if (step.approverHrId) {
      const hr = this.data.allHrPersons.find(p => p.id === step.approverHrId);
      return hr ? hr.name : step.approverHrId;
    }
    return localeCopy.copy_86bbf0d28e;
  },

  getActionLabel(actionType) {
    actionType = normalizeApprovalActionTypeForView(actionType);
    if (actionType === 'pass') return localeCopy.copy_8e2f75159e;
    if (actionType === 'sign') return localeCopy.copy_49cbf30d6b;
    if (actionType === 'estamp') return localeCopy.copy_7e6630535d;
    if (actionType === 'both') return localeCopy.copy_a63d02480e;
    return actionType || localeCopy.copy_8e2f75159e;
  },

  getScopeLabel(scopeType, scopeDepartmentName, scopeWorkGroupName) {
    if (scopeType === 'same_department') return localeCopy.copy_37ad645951;
    if (scopeType === 'same_work_group') return localeCopy.copy_2c67faf1c7;
    if (scopeType === 'specific_department' && scopeDepartmentName) return scopeDepartmentName;
    if (scopeType === 'specific_work_group' && scopeWorkGroupName) return (scopeDepartmentName || '') + ' · ' + scopeWorkGroupName;
    return localeCopy.copy_9b3c1f7a01;
  },

  inferAuditFileMime(fileName, base64) {
    let head = String(base64 || '').slice(0, 16);
    if (head.indexOf('iVBOR') === 0) return 'image/png';
    if (head.indexOf('/9j') === 0) return 'image/jpeg';
    if (head.indexOf('UklGR') === 0) return 'image/webp';
    if (head.indexOf('JVBER') === 0) return 'application/pdf';

    let lowerName = String(fileName || '').toLowerCase();
    if (lowerName.endsWith('.png')) return 'image/png';
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
    if (lowerName.endsWith('.webp')) return 'image/webp';
    if (lowerName.endsWith('.pdf')) return 'application/pdf';
    return '';
  },

  validateAuditUploadFile(fileName, fileSize, base64) {
    let mimeType = this.inferAuditFileMime(fileName, base64);
    if (!mimeType || AUDIT_ALLOWED_MIMES.indexOf(mimeType) < 0) {
      return { ok: false, message: localeCopy.copy_75bca7ebb3 };
    }
    if ((fileSize || 0) > AUDIT_MAX_FILE_SIZE) {
      return { ok: false, message: localeCopy.copy_9288d54fa0 };
    }
    if (String(base64 || '').length > Math.ceil(AUDIT_MAX_FILE_SIZE * 4 / 3) + 1024) {
      return { ok: false, message: localeCopy.copy_9288d54fa0 };
    }
    return { ok: true, mimeType: mimeType };
  },

  // File upload
  chooseFile() {
    const that = this;
    wx.chooseMessageFile({
      count: 3,
      type: 'file',
      success(res) {
        that.uploadFiles(res.tempFiles);
      }
    });
  },

  chooseImage() {
    const that = this;
    wx.chooseImage({
      count: 3,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success(res) {
        const tempFiles = res.tempFilePaths.map((p, i) => ({
          path: p,
          name: `image_${Date.now()}_${i}.jpg`,
          size: res.tempFiles ? (res.tempFiles[i] ? res.tempFiles[i].size : 0) : 0
        }));
        that.uploadFiles(tempFiles);
      }
    });
  },

  async uploadFiles(tempFiles) {
    if (!tempFiles || !tempFiles.length) return;
    this.setData({ uploading: true });
    const that = this;
    const uploaded = [...this.data.uploadedFiles];
    let errorCount = 0;
    let firstError = '';

    // Use async readFile per file, handled sequentially
    for (let i = 0; i < tempFiles.length; i++) {
      const tf = tempFiles[i];
      try {
        const base64 = await new Promise(function(resolve, reject) {
          wx.getFileSystemManager().readFile({
            filePath: tf.path,
            encoding: 'base64',
            success: function(r) { resolve(r.data); },
            fail: function(err) { reject(err); }
          });
        });
        const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const validation = this.validateAuditUploadFile(tf.name, tf.size || 0, base64);
        if (!validation.ok) {
          throw new Error((tf.name || localeCopy.copy_afad9f1b56) + ': ' + validation.message);
        }
        uploaded.push({
          fileId: fileId,
          fileName: tf.name || 'unknown',
          mimeType: validation.mimeType,
          fileSize: tf.size || 0,
          fileHash: '',
          tmpPath: tf.path,
          base64: base64
        });
      } catch (e) {
        errorCount++;
        if (!firstError) firstError = getErrorText(e, localeCopy.copy_03d69a9d28);
        console.error(localeCopy.copy_e4882ec81b, tf.name, e);
      }
    }

    if (uploaded.length > this.data.uploadedFiles.length) {
      this.setData({ uploadedFiles: uploaded });
    } else if (errorCount > 0) {
      showShortToast(firstError || localeCopy.copy_03d69a9d28);
    }
    this.setData({ uploading: false });
  },

  removeUploadedFile(e) {
    const idx = e.currentTarget.dataset.index;
    const uploaded = [...this.data.uploadedFiles];
    uploaded.splice(idx, 1);
    this.setData({ uploadedFiles: uploaded });
  },

  async submitAudit() {
    if (!this.ensureActiveAssignment()) return;
    const { createMode, selectedTemplateId, createTitle, uploadedFiles, adHocSteps, resubmitMode } = this.data;

    if (!createTitle) { showShortToast(localeCopy.copy_b99e01d38c); return; }
    if (!uploadedFiles.length) { showShortToast(localeCopy.copy_88218650ba); return; }

    this.setData({ loading: true });
    const serverFiles = [];
    try {
      for (const uf of uploadedFiles) {
        const uploadRes = await callFunction({
          name: 'uploadAuditFile',
          data: {
            fileBase64: uf.base64,
            fileName: uf.fileName,
            mimeType: uf.mimeType
          }
        });
        if (uploadRes.status === 'success') {
          serverFiles.push({
            fileId: uploadRes.fileId,
            fileName: uploadRes.fileName,
            mimeType: uploadRes.mimeType,
            fileSize: uploadRes.fileSize,
            fileHash: uploadRes.fileHash,
            fileToken: uploadRes.fileToken
          });
        } else {
          throw new Error(uploadRes.message || localeCopy.copy_060a64d6e7);
        }
      }
    } catch (e) {
      this.setData({ loading: false });
      showShortToast(getErrorText(e, localeCopy.copy_060a64d6e7));
      return;
    }

    try {
      let res;
      if (createMode === 'template') {
        if (!selectedTemplateId) { showShortToast(localeCopy.copy_0172f60994); this.setData({ loading: false }); return; }
        // Collect step overrides from template step preview
        let stepOverrides = (this.data.templateStepOverrides || [])
          .filter(function(o) { return o.personHrIds && o.personHrIds.length && o.assignmentIds && o.assignmentIds.length; })
          .map(function(o) {
            return { stepIndex: o.stepIndex, personHrIds: o.personHrIds, assignmentIds: o.assignmentIds };
          });
        res = await callFunction({
          name: 'startAuditSubmission',
          data: { templateId: selectedTemplateId, title: createTitle, description: this.data.createDesc, files: serverFiles, stepOverrides: stepOverrides }
        });
      } else {
        if (!adHocSteps.length) { showShortToast(localeCopy.copy_9167c33257); this.setData({ loading: false }); return; }
        // Strip display-only fields before sending
        const cleanSteps = adHocSteps.map(s => ({
          name: s.name || '',
          approverType: s.approverType,
          approverIdentityId: s.approverIdentityId || '',
          approverHrId: s.approverHrId || '',
          approverAssignmentId: s.approverAssignmentId || '',
          actionType: s.actionType || 'pass',
          scopeType: s.scopeType || 'all',
          scopeDepartmentId: s.scopeDepartmentId || '',
          scopeWorkGroupId: s.scopeWorkGroupId || '',
          conditions: Array.isArray(s.conditions) ? s.conditions : []
        }));
        res = await callFunction({
          name: 'startAdHocAudit',
          data: { title: createTitle, description: this.data.createDesc, resubmitMode, steps: cleanSteps, files: serverFiles }
        });
      }

      if (res.status === 'success') {
        showShortToast(localeCopy.copy_69df1816f0);
        wx.redirectTo({ url: `/subpackages/audit/pages/submissionDetail/submissionDetail?id=${res.id}` });
      } else {
        if (!this.handleWorkContextFailure(res)) {
          showShortToast(res.message || localeCopy.copy_8831c65b75);
        }
      }
    } catch (e) {
      if (!this.handleWorkContextFailure(e)) {
        showShortToast(getErrorText(e, localeCopy.copy_8831c65b75));
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  // ═══════════════════════════════════════════════
  // View Detail
  // ═══════════════════════════════════════════════

  async loadDetail() {
    const request = orgSession.beginRequest(this, 'submissionDetail');
    this.setData({ loading: true });
    try {
      const res = await callFunction({
        name: 'getSubmissionDetail',
        data: { submissionId: this.data.submissionId }
      });
      if (!orgSession.isRequestCurrent(this, request)) return;
      if (res.status === 'success') {
        const submissionView = Object.assign({}, res.submission, {
          submittedAssignmentView: workContextView.normalizeSnapshot(res.submission.submittedContextSnapshot)
        });
        const submissionStatus = submissionView.status;
        const currentStepIndex = submissionView.currentStepIndex || 0;

        // Build flow timeline from server events + steps
        let serverEvents = res.events || [];
        let rawSteps = (res.steps || []).map(normalizeApprovalStepForView);
        let flowTimeline = [];

        // 1. Build lifecycle nodes from ALL server events — no filtering
        //    Every event (submit/withdraw/resubmit/approve/reject/edit) is part of the audit trail
        let lifecycleEvents = serverEvents;

        // Build a lookup map: key = round_stepIndex_eventType → operatorName
        // Used to resolve the ACTUAL operator (not the designated approver) for step nodes
        let eventOperatorMap = {};
        for (let eomi = 0; eomi < lifecycleEvents.length; eomi++) {
          let eo = lifecycleEvents[eomi];
          if ((eo.eventType === 'approve' || eo.eventType === 'reject') && eo.stepIndex != null) {
            let eoKey = (eo.round || 1) + '_' + eo.stepIndex + '_' + eo.eventType;
            eventOperatorMap[eoKey] = {
              operatorName: eo.operatorName || '',
              comment: eo.comment || '',
              time: formatAuditTime(eo.createdAt, eo.createdAtReviewStatus),
              assignmentView: workContextView.normalizeSnapshot(eo.operatorContextSnapshot)
            };
          }
        }

        // 2. Group steps by round
        let rounds = {};
        for (let si = 0; si < rawSteps.length; si++) {
          let s = rawSteps[si];
          let r = s.round || 1;
          if (!rounds[r]) rounds[r] = [];
          rounds[r].push(s);
        }
        let roundKeys = Object.keys(rounds).sort(function(a, b) { return Number(a) - Number(b); });

        // 3. Find the first submit event (round 1)
        let initialSubmit = null;
        let usedEventIdx = 0;
        for (let ei2 = 0; ei2 < lifecycleEvents.length; ei2++) {
          if (lifecycleEvents[ei2].eventType === 'submit' && lifecycleEvents[ei2].round === 1) {
            initialSubmit = lifecycleEvents[ei2];
            usedEventIdx = ei2 + 1;
            break;
          }
        }

        // Only show submit if there IS a submit event (not for drafts with no events)
        if (initialSubmit) {
          flowTimeline.push({
            _key: 'lifecycle_submit',
            type: 'lifecycle',
            event: 'submit',
            label: localeCopy.copy_c94eb77b73,
            time: formatAuditTime(initialSubmit.createdAt, initialSubmit.createdAtReviewStatus),
            iconName: 'file',
            operatorName: initialSubmit.operatorName || '',
            operatorAssignmentView: workContextView.normalizeSnapshot(initialSubmit.operatorContextSnapshot),
            comment: ''
          });
        }

        // 4. For each round, show steps with lifecycle events between
        let nextEventIdx = usedEventIdx;

        for (let ri = 0; ri < roundKeys.length; ri++) {
          let round = Number(roundKeys[ri]);
          let roundSteps = rounds[round].sort(function(a, b) { return a.sortOrder - b.sortOrder; });

          // If round > 1, show ALL lifecycle events between previous round and this round's resubmit
          if (round > 1) {
            // Find the resubmit event index for this round
            let resubmitEvtIdx = -1;
            for (let ei3 = nextEventIdx; ei3 < lifecycleEvents.length; ei3++) {
              if (lifecycleEvents[ei3].eventType === 'resubmit' && lifecycleEvents[ei3].round === round) {
                resubmitEvtIdx = ei3;
                break;
              }
            }

            // Show ALL events BEFORE the resubmit (e.g., withdraw, edit)
            // that happened between the previous round and this resubmit
            let untilIdx = resubmitEvtIdx >= 0 ? resubmitEvtIdx : lifecycleEvents.length;
            for (let eiPre = nextEventIdx; eiPre < untilIdx; eiPre++) {
              let interEvt = lifecycleEvents[eiPre];
              if (interEvt.eventType === 'approve' || interEvt.eventType === 'reject') {
                continue;
              }
              let interIconMap = { withdraw: 'chevron-right', resubmit: 'edit', submit: 'file', edit: 'edit', approve: 'check', reject: 'x' };
              let interLabelMap = { withdraw: localeCopy.copy_0f438fa581, resubmit: localeCopy.copy_aed5de2d69, submit: localeCopy.copy_c94eb77b73, edit: localeCopy.copy_cacc39a0fd, approve: localeCopy.copy_126a0e1f4c, reject: localeCopy.copy_e4c3cdbf04 };
              let interStepLabel = '';
              if ((interEvt.eventType === 'approve' || interEvt.eventType === 'reject') && interEvt.stepIndex) {
                interStepLabel = localeCopy.copy_93c50c01c0 + interEvt.stepIndex + localeCopy.copy_493a127a99;
              }
              flowTimeline.push({
                _key: 'lifecycle_inter_' + interEvt.id,
                type: 'lifecycle',
                event: interEvt.eventType,
                label: interLabelMap[interEvt.eventType] || interEvt.eventType,
                subLabel: (interEvt.round > 1 ? localeCopy.copy_93c50c01c0 + interEvt.round + localeCopy.copy_4707e47a7a : '') + interStepLabel,
                time: formatAuditTime(interEvt.createdAt, interEvt.createdAtReviewStatus),
                iconName: interIconMap[interEvt.eventType] || 'clock',
                comment: interEvt.comment || '',
                operatorName: interEvt.operatorName || '',
                operatorAssignmentView: workContextView.normalizeSnapshot(interEvt.operatorContextSnapshot)
              });
            }

            if (resubmitEvtIdx >= 0) {
              let resubmitEvt = lifecycleEvents[resubmitEvtIdx];
              flowTimeline.push({
                _key: 'lifecycle_resubmit_r' + round,
                type: 'lifecycle',
                event: 'resubmit',
                label: localeCopy.copy_aed5de2d69,
                subLabel: localeCopy.copy_93c50c01c0 + round + localeCopy.copy_14144be09d,
                time: formatAuditTime(resubmitEvt.createdAt, resubmitEvt.createdAtReviewStatus),
                iconName: 'edit',
                operatorName: resubmitEvt.operatorName || '',
                operatorAssignmentView: workContextView.normalizeSnapshot(resubmitEvt.operatorContextSnapshot),
                comment: ''
              });
              nextEventIdx = resubmitEvtIdx + 1;
            } else {
              // Fallback: still show round marker even if no event
              flowTimeline.push({
                _key: 'lifecycle_resubmit_r' + round,
                type: 'lifecycle',
                event: 'resubmit',
                label: localeCopy.copy_aed5de2d69,
                subLabel: localeCopy.copy_93c50c01c0 + round + localeCopy.copy_14144be09d,
                iconName: 'edit',
                operatorName: '',
                comment: ''
              });
              nextEventIdx = lifecycleEvents.length;
            }
          }

          let hasProcessedSteps = false;
          let hasFutureSteps = false;

          // Determine the max round for hiding stale pending steps
          let maxRoundForSteps = Math.max.apply(null, roundKeys.map(function(k) { return Number(k); }));

          for (let si2 = 0; si2 < roundSteps.length; si2++) {
            let step = roundSteps[si2];
            let flowNodeClass, flowDotClass, flowIcon, flowStatusLabel, flowTagClass;

            // For non-last rounds, skip pending steps that were never reached
            // (they belong to a completed/abandoned round and would show as confusing "○ 未到达")
            if (round < maxRoundForSteps && step.status === 'pending') {
              // Only skip if the step was beyond what was processed in that round
              // Keep rejected/approved steps from old rounds
              continue;
            }

            let approverDesc = step.approverDesc || '';
            let conditionsDisplay = step.stepConditionsDisplay || [];

            // If the server approverDesc is empty or looks incomplete (no actual names),
            // try to build a better description from individual fields or conditions display
            if (!approverDesc || approverDesc.indexOf(localeCopy.copy_86bbf0d28e) >= 0) {
              // Try conditions display first (multi-condition, more detailed)
              if (conditionsDisplay.length) {
                approverDesc = conditionsDisplay.join(localeCopy.copy_17bcc41217);
              }
              // If still empty, fall back to individual fields
              if (!approverDesc || approverDesc.indexOf(localeCopy.copy_86bbf0d28e) >= 0) {
                if (step.approverType === 'specific_person' || (step.approverName && step.approverName !== localeCopy.copy_86bbf0d28e)) {
                  approverDesc = localeCopy.copy_d3028048b3 + (step.approverName || localeCopy.copy_86bbf0d28e) + localeCopy.copy_7abed5378f;
                } else {
                  let identName = step.approverIdentityName || localeCopy.copy_c76fae0e08;
                  let scopeType = step.scopeType || 'all';
                  if (scopeType === 'all' || !scopeType) {
                    approverDesc = localeCopy.copy_9b774f950c + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'same_department') {
                    approverDesc = localeCopy.copy_fc98ff863c + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'same_work_group') {
                    approverDesc = localeCopy.copy_d0348010eb + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'specific_department') {
                    let deptName = step.scopeDepartmentName || localeCopy.copy_b3604f443f;
                    approverDesc = localeCopy.copy_d3028048b3 + deptName + ' ' + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'specific_work_group') {
                    let deptName2 = step.scopeDepartmentName || '';
                    let wgName = step.scopeWorkGroupName || '';
                    let location = [deptName2, wgName].filter(Boolean).join('·') || localeCopy.copy_258347beac;
                    approverDesc = localeCopy.copy_d3028048b3 + location + ' ' + identName + localeCopy.copy_7abed5378f;
                  } else {
                    approverDesc = localeCopy.copy_d3028048b3 + identName + localeCopy.copy_7abed5378f;
                  }
                }
              }
            }

            let actionMap = { pass: localeCopy.copy_8e2f75159e, sign: localeCopy.copy_49cbf30d6b, estamp: localeCopy.copy_7e6630535d, both: localeCopy.copy_a63d02480e };
            let actionLabel = actionMap[step.actionType] || step.actionType || localeCopy.copy_8e2f75159e;
            let completedStepLabelMap = { pass: localeCopy.copy_8984f2dd04, sign: localeCopy.copy_3ef3c50164, estamp: localeCopy.copy_0657662c42, both: localeCopy.copy_db18a7c8cf };
            let completedStepLabel = completedStepLabelMap[step.actionType] || localeCopy.copy_8e66e528a2;

            if (step.status === 'rejected') {
              flowNodeClass = 'flow-node-rejected';
              flowDotClass = 'flow-dot-rejected';
              flowIcon = 'cross';
              flowStatusLabel = localeCopy.copy_70d7f7f742;
              flowTagClass = 'flow-tag-rejected';
            } else if (submissionStatus === 'approved') {
              flowNodeClass = 'flow-node-done';
              flowDotClass = 'flow-dot-done';
              flowIcon = 'check';
              flowStatusLabel = completedStepLabel;
              flowTagClass = 'flow-tag-done';
            } else if (submissionStatus === 'pending' || submissionStatus === 'draft') {
              flowNodeClass = 'flow-node-pending';
              flowDotClass = 'flow-dot-pending';
              flowIcon = 'number';
              flowStatusLabel = localeCopy.copy_03c3f77e01;
              flowTagClass = 'flow-tag-pending';
            } else if (step.status === 'approved') {
              flowNodeClass = 'flow-node-done';
              flowDotClass = 'flow-dot-done';
              flowIcon = 'check';
              flowStatusLabel = completedStepLabel;
              flowTagClass = 'flow-tag-done';
            } else if (step.sortOrder === currentStepIndex && step.status === 'pending' && submissionStatus === 'in_progress') {
              flowNodeClass = 'flow-node-active';
              flowDotClass = 'flow-dot-active';
              flowIcon = 'number';
              flowStatusLabel = localeCopy.copy_532a477356;
              flowTagClass = 'flow-tag-active';
            } else if (step.sortOrder < currentStepIndex) {
              flowNodeClass = 'flow-node-done';
              flowDotClass = 'flow-dot-done';
              flowIcon = 'check';
              flowStatusLabel = completedStepLabel;
              flowTagClass = 'flow-tag-done';
            } else {
              flowNodeClass = 'flow-node-pending';
              flowDotClass = 'flow-dot-pending';
              flowIcon = 'number';
              flowStatusLabel = localeCopy.copy_9baefe7c49;
              flowTagClass = 'flow-tag-pending';
              hasFutureSteps = true;
            }

            if (step.status === 'approved' || step.status === 'rejected' ||
                (step.sortOrder === currentStepIndex && step.status === 'pending' && submissionStatus === 'in_progress')) {
              hasProcessedSteps = true;
            }

            // Look up the ACTUAL operator from the audit event (not the designated approver)
            let eventKey = (step.round || 1) + '_' + step.sortOrder + '_' + (step.status === 'approved' ? 'approve' : 'reject');
            let eventInfo = eventOperatorMap[eventKey] || {};
            let actualOperatorName = eventInfo.operatorName || '';
            let actualComment = eventInfo.comment || step.comment || '';
            let actualProcessedAt = eventInfo.time || (step.processedAt
              ? formatAuditTime(step.processedAt, step.processedAtReviewStatus)
              : '');

            flowTimeline.push({
              _key: 'step_' + step.id,
              type: 'step',
              id: step.id,
              sortOrder: step.sortOrder || (si2 + 1),
              stepName: step.stepName || step.name || '',
              approverType: step.approverType,
              approverHrId: step.approverHrId,
              approverName: step.approverName,
              operatorName: actualOperatorName || step.approverName,
              approverIdentityId: step.approverIdentityId,
              approverIdentityName: step.approverIdentityName,
              scopeType: step.scopeType,
              scopeDepartmentId: step.scopeDepartmentId,
              scopeDepartmentName: step.scopeDepartmentName,
              scopeWorkGroupId: step.scopeWorkGroupId,
              scopeWorkGroupName: step.scopeWorkGroupName,
              actionType: step.actionType,
              allowApproverDesignation: step.allowApproverDesignation === true,
              status: step.status,
              comment: actualComment,
              rejectionReason: step.status === 'rejected' ? (eventInfo.comment || step.rejectionReason || '') : step.rejectionReason,
              round: step.round,
              processedAtText: actualProcessedAt,
              processedAssignmentView: eventInfo.assignmentView && eventInfo.assignmentView.hasSnapshot
                ? eventInfo.assignmentView
                : workContextView.normalizeSnapshot(step.processedContextSnapshot),
              flowNodeClass: flowNodeClass,
              flowDotClass: flowDotClass,
              flowIcon: flowIcon,
              flowStatusLabel: flowStatusLabel,
              flowTagClass: flowTagClass,
              approverDesc: approverDesc,
              actionLabel: actionLabel,
              conditionsDisplay: conditionsDisplay
            });
          }

          // Inject separator — only for the LAST round
          let maxRound = Math.max.apply(null, roundKeys.map(function(k) { return Number(k); }));
          if (hasProcessedSteps && hasFutureSteps && round === maxRound) {
            let remainingCount = roundSteps.filter(function(rs) {
              return rs.status === 'pending' && rs.sortOrder > currentStepIndex;
            }).length;
            if (remainingCount > 0) {
              let insertIdx = -1;
              for (let fi = 0; fi < flowTimeline.length; fi++) {
                if (flowTimeline[fi].type === 'step' && flowTimeline[fi].flowStatusLabel === localeCopy.copy_9baefe7c49) {
                  insertIdx = fi;
                  break;
                }
              }
              if (insertIdx > 0) {
                flowTimeline.splice(insertIdx, 0, {
                  _key: 'separator_r' + round + '_remaining',
                  type: 'separator',
                  label: localeCopy.copy_361de3f050 + remainingCount + localeCopy.copy_239cbf0257
                });
              }
            }
          }
        }

        // 5. Remaining lifecycle events after last round — show ALL event types
        let lateIconMap = { withdraw: 'chevron-right', resubmit: 'edit', submit: 'file', edit: 'edit', approve: 'check', reject: 'x' };
        let lateLabelMap = { withdraw: localeCopy.copy_0f438fa581, resubmit: localeCopy.copy_aed5de2d69, submit: localeCopy.copy_c94eb77b73, edit: localeCopy.copy_cacc39a0fd, approve: localeCopy.copy_126a0e1f4c, reject: localeCopy.copy_e4c3cdbf04 };
        for (let ei4 = nextEventIdx; ei4 < lifecycleEvents.length; ei4++) {
          let lateEvt = lifecycleEvents[ei4];
          if (lateEvt.eventType === 'approve' || lateEvt.eventType === 'reject') {
            continue;
          }
          flowTimeline.push({
            _key: 'lifecycle_late_' + lateEvt.id,
            type: 'lifecycle',
            event: lateEvt.eventType,
            label: lateLabelMap[lateEvt.eventType] || lateEvt.eventType,
            subLabel: lateEvt.round > 1 ? localeCopy.copy_93c50c01c0 + lateEvt.round + localeCopy.copy_14144be09d : '',
            time: formatAuditTime(lateEvt.createdAt, lateEvt.createdAtReviewStatus),
            iconName: lateIconMap[lateEvt.eventType] || 'clock',
            operatorName: lateEvt.operatorName || '',
            operatorAssignmentView: workContextView.normalizeSnapshot(lateEvt.operatorContextSnapshot),
            comment: lateEvt.comment || ''
          });
        }

        if (submissionStatus === 'approved') {
          let lastApproveEvt = null;
          for (let lai = lifecycleEvents.length - 1; lai >= 0; lai--) {
            if (lifecycleEvents[lai].eventType === 'approve') {
              lastApproveEvt = lifecycleEvents[lai];
              break;
            }
          }
          flowTimeline.push({
            _key: 'lifecycle_final_approved',
            type: 'lifecycle',
            event: 'approved',
            label: localeCopy.copy_126a0e1f4c,
            subLabel: localeCopy.copy_1188f4f2ad,
            time: lastApproveEvt
              ? formatAuditTime(lastApproveEvt.createdAt, lastApproveEvt.createdAtReviewStatus)
              : '',
            iconName: 'check',
            operatorName: lastApproveEvt ? (lastApproveEvt.operatorName || '') : '',
            operatorAssignmentView: workContextView.normalizeSnapshot(lastApproveEvt && lastApproveEvt.operatorContextSnapshot),
            comment: lastApproveEvt ? (lastApproveEvt.comment || '') : ''
          });
        }

        // ── Compute flow progress ──
        // “从驳回步骤继续”不会复制前面已通过的步骤；按每个步骤序号的最新
        // 有效记录合并进度，避免重提后把已完成步骤错误清零。
        const progressState = calculateWorkflowProgress(rawSteps);
        let stepsPerRound = progressState.stepsPerRound;
        let currentRoundApproved = progressState.approvedCount;
        let flowProgressPercent, flowProgressText;

        if (submissionStatus === 'approved') {
          flowProgressPercent = 100;
          flowProgressText = localeCopy.copy_73ad4b84ff + stepsPerRound + localeCopy.copy_d2dbf88099;
        } else if (submissionStatus === 'rejected') {
          const rejectedStep = progressState.rejectedStep;
          flowProgressPercent = Math.round((currentRoundApproved / stepsPerRound) * 100);
          flowProgressText = rejectedStep ? localeCopy.copy_93c50c01c0 + rejectedStep.sortOrder + '/' + stepsPerRound + localeCopy.copy_39bf6116f7 : localeCopy.copy_5d5af942c5;
        } else if (submissionStatus === 'pending') {
          flowProgressPercent = 0;
          flowProgressText = localeCopy.copy_c387a19415 + stepsPerRound + localeCopy.copy_d2dbf88099;
        } else if (submissionStatus === 'withdrawn') {
          flowProgressPercent = Math.round((currentRoundApproved / stepsPerRound) * 100);
          flowProgressText = localeCopy.copy_4aa1a817a1 + stepsPerRound + localeCopy.copy_d2dbf88099;
        } else {
          // in_progress
          flowProgressPercent = Math.round((currentRoundApproved / stepsPerRound) * 100);
          flowProgressText = localeCopy.copy_93c50c01c0 + currentStepIndex + '/' + stepsPerRound + localeCopy.copy_500e30ed6d;
        }

        // Detect active step for inline approval UI
        let activeApprovalStep = null;
        let nextStepInfo = null;
        for (let fi = 0; fi < flowTimeline.length; fi++) {
          if (flowTimeline[fi].type === 'step') {
            if (flowTimeline[fi].flowNodeClass === 'flow-node-active') {
              activeApprovalStep = flowTimeline[fi];
            }
            // The first future step right after the active one is the "next step"
            if (!nextStepInfo && activeApprovalStep && flowTimeline[fi].sortOrder === (activeApprovalStep.sortOrder + 1)) {
              nextStepInfo = {
                sortOrder: flowTimeline[fi].sortOrder,
                approverDesc: flowTimeline[fi].approverDesc,
                allowApproverDesignation: flowTimeline[fi].allowApproverDesignation === true
              };
            }
          }
        }

        // Fallback: if active step not found via flowTimeline, find it from rawSteps
        // (handles edge cases where the flowTimeline filtering skips the active step)
        let computedActiveStepId = activeApprovalStep ? activeApprovalStep.id : '';
        if (!activeApprovalStep && rawSteps.length > 0 && submissionStatus === 'in_progress') {
          let actionMap2 = { pass: localeCopy.copy_8e2f75159e, sign: localeCopy.copy_49cbf30d6b, estamp: localeCopy.copy_7e6630535d, both: localeCopy.copy_a63d02480e };
          // Find max round first
          let maxRound2 = 0;
          for (let si3 = 0; si3 < rawSteps.length; si3++) {
            maxRound2 = Math.max(maxRound2, rawSteps[si3].round || 1);
          }
          // Find pending step matching currentStepIndex from latest round
          for (let si4 = 0; si4 < rawSteps.length; si4++) {
            let rawStep = rawSteps[si4];
            if ((rawStep.round || 1) === maxRound2 &&
                rawStep.sortOrder === currentStepIndex &&
                rawStep.status === 'pending') {
              activeApprovalStep = {
                id: rawStep.id,
                sortOrder: rawStep.sortOrder,
                stepName: rawStep.stepName || rawStep.name || '',
                actionType: rawStep.actionType,
                actionLabel: actionMap2[rawStep.actionType] || rawStep.actionType || localeCopy.copy_8e2f75159e,
                approverDesc: rawStep.approverDesc || localeCopy.copy_ae42f47cf6,
                round: rawStep.round || 1,
                conditionsDisplay: rawStep.stepConditionsDisplay || [],
                processedAssignmentView: workContextView.normalizeSnapshot(rawStep.processedContextSnapshot)
              };
              computedActiveStepId = rawStep.id;
              break;
            }
          }
        }

        if (activeApprovalStep && !nextStepInfo) {
          let latestRound = rawSteps.reduce(function(max, item) {
            return Math.max(max, item.round || 1);
          }, 1);
          let nextRawStep = rawSteps.find(function(item) {
            return (item.round || 1) === latestRound && item.sortOrder === activeApprovalStep.sortOrder + 1;
          });
          if (nextRawStep) {
            nextStepInfo = {
              sortOrder: nextRawStep.sortOrder,
              approverDesc: nextRawStep.approverDesc || localeCopy.copy_a5674f1e5b,
              allowApproverDesignation: nextRawStep.allowApproverDesignation === true
            };
          }
        }

        if (!orgSession.isRequestCurrent(this, request)) return;
        this.setData({
          submission: submissionView,
          flowTimeline: flowTimeline,
          rawStepCount: rawSteps.length,
          steps: rawSteps,
          files: res.files || [],
          signatures: (res.signatures || []).map((item) => Object.assign({}, item, {
            signedAtText: formatAuditDetailTime(item.signedAt, item.signedAtReviewStatus)
          })),
          flowProgressPercent: flowProgressPercent,
          flowProgressText: flowProgressText,
          activeApprovalStepId: computedActiveStepId,
          activeApprovalStep: activeApprovalStep,
          designatedNextPersons: [],
          nextStepInfo: nextStepInfo,
          approvalVisible: false,
          approvalAction: '',
          approvalComment: '',
          rejectionReason: '',
          pendingSignatures: [],
          approvalWarning: '',
          // User role flags for conditional UI
          userIsSubmitter: res.userIsSubmitter || false,
          userIsApprover: Boolean(res.userIsApprover && this.data.hasActiveAssignment),
          userIsAdmin: res.userIsAdmin || false,
          expandedNodeKey: ''
        });

        // 阅读游标只属于当前岗位发起的申请；审批人和管理员查看详情时不写入。
        if (res.userIsSubmitter && orgSession.isRequestCurrent(this, request)) {
          try {
            await callFunction({ name: 'markSubmissionRead', data: { submissionId: res.submission.id } });
          } catch (_) {}
        }
      } else {
        showShortToast(res.message || localeCopy.copy_e52119b17e);
      }
    } catch (e) {
      showShortToast(getErrorText(e, localeCopy.copy_e52119b17e));
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ loading: false });
    }
  },

  // ═══════════════════════════════════════════════
  // Approval Actions
  // ═══════════════════════════════════════════════

  openApprove(e) {
    const stepId = e.currentTarget.dataset.stepId;
    this.setData({
      approvalVisible: false,
      approvalStepId: stepId,
      approvalAction: ''
    });
    wx.nextTick(function() {
      wx.pageScrollTo({ selector: '#active-approval-card', duration: 300 });
    });
  },

  openReject(e) {
    const stepId = e.currentTarget.dataset.stepId;
    this.setData({
      approvalVisible: true,
      approvalStepId: stepId,
      approvalAction: 'reject',
      rejectionReason: '',
      pendingSignatures: []
    });
  },

  closeApproval() {
    this.setData({ approvalVisible: false, signaturePadVisible: false });
  },

  onApprovalCommentInput(e) {
    this.setData({ approvalComment: e.detail.value });
  },

  onRejectionReasonInput(e) {
    this.setData({ rejectionReason: e.detail.value });
  },

  // ═══════════════════════════════════════════════
  // Signature Source Picker (saved signatures + new drawing)
  // ═══════════════════════════════════════════════

  // Open signature source picker for a specific file
  addSignatureForFile(e) {
    let fileId = e.currentTarget.dataset.fileId;
    let fileName = e.currentTarget.dataset.fileName;
    this.setData({
      sigSourceFileId: fileId,
      sigSourceFileName: fileName,
      sigSourcePickerVisible: true,
      sigSaveNew: false,
      sigSaveName: ''
    });
    this.loadMySignatures();
  },

  closeSigSourcePicker() {
    this.setData({ sigSourcePickerVisible: false });
  },

  // Load user's saved signatures
  async loadMySignatures() {
    try {
      let res = await callFunction({ name: 'listMySignatures', data: {} });
      if (res.status === 'success') {
        this.setData({ mySignatures: res.signatures || [] });
      }
    } catch (e) {
      console.error('[audit] loadMySignatures failed:', e);
      this.setData({ mySignatures: [] });
    }
  },

  // User selected a saved signature template — auto-open placement
  onSelectSavedSignature(e) {
    let that = this;
    let sigImage = e.currentTarget.dataset.sigImage;
    let fileId = this.data.sigSourceFileId;
    let sigs = [...this.data.pendingSignatures];
    let newSigIdx = sigs.length;
    let newSig = {
      _idx: 'sig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      fileId: fileId,
      signatureType: 'signature',
      stampName: '',
      stampId: '',
      imageData: sigImage,
      positionX: 0.5,
      positionY: 0.3,
      size: 1,
      rotation: 0,
      page: 1
    };
    newSig.posText = this._computeSigPosText(newSig);
    sigs.push(newSig);
    this.setData({
      pendingSignatures: sigs,
      sigSourcePickerVisible: false,
      approvalWarning: ''
    });
    this.updateApprovalWarning();

    // Auto-open placement popup for positioning (autoOpened: cancel removes the sig)
    wx.nextTick(() => {
      that._openPlacementForIdx(newSigIdx, true);
    });
  },

  // User wants to draw a new signature — open signature pad from picker
  onOpenNewSignaturePad() {
    let fileId = this.data.sigSourceFileId;
    this._showSignaturePad(fileId, true);
  },

  _showSignaturePad(fileId, closeSourcePicker) {
    this.setData({
      currentSignatureFileId: fileId,
      signaturePadVisible: true,
      sigSourcePickerVisible: closeSourcePicker ? false : this.data.sigSourcePickerVisible
    });
  },

  // Toggle save-new-signature checkbox
  onSigSaveToggle() {
    this.setData({ sigSaveNew: !this.data.sigSaveNew });
  },

  // Input for new signature name
  onSigSaveNameInput(e) {
    this.setData({ sigSaveName: e.detail.value });
  },

  // Signature drawing confirmed — auto-open placement popup
  onSignatureConfirm(e) {
    let that = this;
    let imageData = e.detail.imageData;
    let fileId = this.data.currentSignatureFileId;

    // If user wants to save this signature to library
    if (this.data.sigSaveNew) {
      let saveName = this.data.sigSaveName || (localeCopy.copy_66a2af4df9 + formatAbsoluteDate(Date.now()));
      callFunction({
        name: 'saveSignature',
        data: { id: '', name: saveName, imageData: imageData }
      }).then(function(saveRes) {
        if (saveRes.status === 'success') {
          showShortToast(localeCopy.copy_082505816e);
        }
      }).catch(function() {
        // Non-critical; signature still used for this approval
      });
    }

    let newIdx = '_sig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    let sigs = [...this.data.pendingSignatures];
    let newSigIdx = sigs.length;
    let newSig = {
      _idx: newIdx,
      fileId: fileId,
      signatureType: 'signature',
      stampName: '',
      stampId: '',
      imageData: imageData,
      positionX: 0.5,
      positionY: 0.3,
      size: 1,
      rotation: 0,
      page: 1
    };
    newSig.posText = this._computeSigPosText(newSig);
    sigs.push(newSig);
    this.setData({
      pendingSignatures: sigs,
      signaturePadVisible: false,
      sigSourcePickerVisible: false,
      sigSaveNew: false,
      sigSaveName: '',
      approvalWarning: ''
    });
    this.updateApprovalWarning();

    // Auto-open placement popup for this new signature (autoOpened: cancel removes it)
    wx.nextTick(() => {
      that._openPlacementForIdx(newSigIdx, true);
    });
  },

  // Compute display text for signature/stamp position (used in approval dialog list)
  _computeSigPosText: function (sig) {
    if (!sig || sig.positionX == null || sig.positionY == null) return '';
    let text = (sig.positionX * 100).toFixed(1) + '%, ' + (sig.positionY * 100).toFixed(1) + '%';
    if (sig.page && sig.page > 1) text += localeCopy.copy_6acb97d4c6 + sig.page + localeCopy.copy_f67213967c;
    return text;
  },

  // Utility: open placement popup for a pending signature at given index
  // autoOpened: true when auto-opened after creating a new signature (cancel removes it)
  _openPlacementForIdx(idx, autoOpened) {
    let that = this;
    let sig = this.data.pendingSignatures[idx];
    if (!sig) return;
    let fileId = sig.fileId;
    let files = this.data.files || [];
    let file = files.find(function(f) { return f.id === fileId; });
    let fileName = file ? file.fileName : localeCopy.copy_0c28c344e7;
    let fileMime = file ? file.mimeType : '';

    // Collect all sigs/stamps on the same file
    let fileItems = [];
    for (let i = 0; i < this.data.pendingSignatures.length; i++) {
      let s = this.data.pendingSignatures[i];
      if (s.fileId === fileId) {
        fileItems.push({
          dispIdx: i,
          imageData: s.imageData,
          previewSrc: s.previewSrc || s.imageData || '',
          positionX: s.positionX != null ? s.positionX : 0.5,
          positionY: s.positionY != null ? s.positionY : 0.3,
          size: s.size || 1,
          rotation: s.rotation || 0,
          page: s.page || 1,
          signatureType: s.signatureType
        });
      }
    }

    let currentPage = sig.page || 1;

    // ★ 快照：取消时完整还原到打开前的状态
    //    autoOpened: 快照不含新建的签名 → 取消则签名消失
    //    manual:    快照含全部 → 取消则还原位置/大小/旋转
    if (autoOpened) {
      let sigsBefore = JSON.parse(JSON.stringify(this.data.pendingSignatures));
      sigsBefore.splice(idx, 1);  // 移除新建的签名
      this._placementSnapshot = sigsBefore;
    } else {
      this._placementSnapshot = JSON.parse(JSON.stringify(this.data.pendingSignatures));
    }

    this.setData({
      placementVisible: true,
      placementAutoOpened: !!autoOpened,
      placementType: sig.signatureType,
      placementFileName: fileName,
      placementFileId: fileId,
      placementFileMime: fileMime,
      placementItems: fileItems,
      placementActiveIdx: idx,
      placementPreviewX: sig.positionX != null ? sig.positionX : -1,
      placementPreviewY: sig.positionY != null ? sig.positionY : -1,
      placementSize: Math.round((sig.size || 1) * 100),
      placementRotation: sig.rotation || 0,
      placementCurrentPage: currentPage,
      placementTotalPages: 1,
      placementFileImage: '',
      placementLoading: true,
      placementPosText: sig.positionX != null ? (sig.positionX * 100).toFixed(1) + '%, ' + (sig.positionY * 100).toFixed(1) + '%' : ''
    });

    this._preparePlacementItemPreviews(fileItems).then(function(items) {
      if (that.data.placementVisible && that.data.placementFileId === fileId) {
        that.setData({ placementItems: items });
      }
    });

    this.loadFilePreview(fileId, currentPage);
  },

  _dataUrlToTempFile(dataUrl, prefix) {
    return new Promise(function(resolve, reject) {
      if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) {
        resolve(dataUrl || '');
        return;
      }
      let match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (!match) {
        resolve(dataUrl);
        return;
      }
      let mime = match[1];
      let ext = mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0 ? 'jpg'
        : mime.indexOf('png') >= 0 ? 'png'
          : mime.indexOf('webp') >= 0 ? 'webp' : 'bin';
      let filePath = wx.env.USER_DATA_PATH + '/' + prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      wx.getFileSystemManager().writeFile({
        filePath: filePath,
        data: match[2],
        encoding: 'base64',
        success: function() { resolve(filePath); },
        fail: reject
      });
    });
  },

  async _preparePlacementItemPreviews(items) {
    let result = [];
    for (let i = 0; i < items.length; i++) {
      let item = Object.assign({}, items[i]);
      if ((!item.previewSrc || item.previewSrc.indexOf('data:') === 0) && item.imageData) {
        try {
          item.previewSrc = await this._dataUrlToTempFile(item.imageData, 'audit_sign_preview');
        } catch (e) {
          console.error('[audit] prepare signature preview failed:', e);
          item.previewSrc = item.imageData;
        }
      }
      result.push(item);
    }
    return result;
  },

  closeSignaturePad() {
    this.setData({ signaturePadVisible: false });
  },

  async confirmApproval() {
    if (!this.ensureActiveAssignment()) return;
    const { approvalAction, approvalStepId, rejectionReason, submissionId } = this.data;

    if (approvalAction !== 'reject') {
      this.closeApproval();
      wx.nextTick(function() {
        wx.pageScrollTo({ selector: '#active-approval-card', duration: 300 });
      });
      return;
    }
    if (!rejectionReason) {
      showShortToast(localeCopy.copy_3764af0483);
      return;
    }

    this.setData({ loading: true });
    try {
      const res = await callFunction({
        name: 'rejectStep',
        data: { submissionId, stepId: approvalStepId, rejectionReason }
      });

      if (res.status === 'success') {
        showShortToast(res.message || localeCopy.copy_2220286f1c);
        this.closeApproval();
        const self = this;
        require('../../../../utils/eventBus').emit('approval:done');
        if (this._actionTimer) clearTimeout(this._actionTimer);
        this._actionTimer = setTimeout(function() {
          self._actionTimer = null;
          if (self._pageActive) wx.navigateBack();
        }, 800);
      } else {
        if (!this.handleWorkContextFailure(res)) {
          showShortToast(res.message || localeCopy.copy_0531ed9e78);
        }
      }
    } catch (e) {
      if (!this.handleWorkContextFailure(e)) {
        showShortToast(getErrorText(e, localeCopy.copy_0531ed9e78));
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  // ── Next-step person designation ──

  async openDesignateNextPersonPicker() {
    if (!this.ensureActiveAssignment()) return;
    if (!this.data.nextStepInfo || this.data.nextStepInfo.allowApproverDesignation !== true) {
      showShortToast(localeCopy.copy_97d569974c);
      return;
    }
    this.setData({
      personPickerVisible: true,
      personPickerLoading: true,
      personPickerMode: 'designateNext',
      personPickerDept: localeCopy.copy_31d4595959,
      personPickerIdent: localeCopy.copy_31d4595959,
      personPickerWg: localeCopy.copy_31d4595959,
      personPickerKeyword: '',
      personPickerSelectedIds: [],
      personPickerSelectedList: [],
      personPickerStepActionType: 'pass'
    });

    // Load eligible approvers from server
    let eligibleList = [];
    try {
      let res = await callFunction({ name: 'listEligibleApprovers', data: { submissionId: this.data.submissionId } });
      if (res.status === 'success') {
        eligibleList = this._normalizeApproverList(res.approvers || []);
      } else {
        this.handleWorkContextFailure(res);
      }
    } catch (err) {
      console.error('[audit] listEligibleApprovers (submission) failed:', err);
    }
    this._updatePersonPickerOptions(eligibleList);

    // Pre-populate with current designation
    let preIds = (this.data.designatedNextPersons || []).map(function(p) { return p.assignmentId; }).filter(Boolean);
    let preList = this._selectedAssignmentViews(eligibleList, preIds);
    this.setData({
      personPickerEligibleList: eligibleList,
      personPickerLoading: false,
      personPickerVisible: true,
      personPickerDept: localeCopy.copy_31d4595959,
      personPickerIdent: localeCopy.copy_31d4595959,
      personPickerWg: localeCopy.copy_31d4595959,
      personPickerKeyword: '',
      personPickerSelectedIds: preIds,
      personPickerSelectedList: preList,
      personPickerStepActionType: 'pass',
      personPickerMode: 'designateNext'  // signals confirmPersonPicker to save to designatedNextPersons
    });
    this.applyPersonPickerFilters();
  },

  removeDesignatedNextPerson(e) {
    let assignmentId = e.currentTarget.dataset.assignmentId;
    let list = (this.data.designatedNextPersons || []).filter(function(p) { return p.assignmentId !== assignmentId; });
    this.setData({ designatedNextPersons: list });
  },

  // ═══════════════════════════════════════════════
  // Signature & Stamp Actions
  // ═══════════════════════════════════════════════

  // Open stamp picker for a specific file
  addStampForFile(e) {
    let fileId = e.currentTarget.dataset.fileId;
    let fileName = e.currentTarget.dataset.fileName;
    this.setData({
      stampPickFileId: fileId,
      stampPickFileName: fileName,
      stampPickerVisible: true
    });
    this.loadAvailableStamps();
  },

  // Load stamps available to the current user
  async loadAvailableStamps() {
    try {
      let res = await callFunction({ name: 'listMyStamps', data: {} });
      if (res.status === 'success') {
        this.setData({ availableStamps: res.stamps || [] });
      }
    } catch (e) {
      console.error('[audit] loadAvailableStamps failed:', e);
    }
  },

  closeStampPicker() {
    this.setData({ stampPickerVisible: false });
  },

  // User selected a stamp from the picker
  onStampSelect(e) {
    let that = this;
    let stampId = e.currentTarget.dataset.stampId;
    let stampName = e.currentTarget.dataset.stampName;
    let stampImage = e.currentTarget.dataset.stampImage;
    let fileId = this.data.stampPickFileId;
    let sigs = [...this.data.pendingSignatures];
    let newSigIdx = sigs.length;
    let newStampSig = {
      _idx: 'stamp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      fileId: fileId,
      signatureType: 'stamp',
      stampName: stampName,
      stampId: stampId,
      imageData: stampImage,
      positionX: 0.5,
      positionY: 0.3,
      size: 1,
      rotation: 0,
      page: 1
    };
    newStampSig.posText = this._computeSigPosText(newStampSig);
    sigs.push(newStampSig);
    this.setData({
      pendingSignatures: sigs,
      stampPickerVisible: false,
      approvalWarning: ''
    });
    this.updateApprovalWarning();

    // Auto-open placement popup (autoOpened: cancel removes the stamp)
    wx.nextTick(() => {
      that._openPlacementForIdx(newSigIdx, true);
    });
  },

  // Remove a pending signature/stamp
  removePendingSign(e) {
    let idx = parseInt(e.currentTarget.dataset.sigIdx);
    let sigs = [...this.data.pendingSignatures];
    if (idx >= 0 && idx < sigs.length) {
      sigs.splice(idx, 1);
    }
    this.setData({ pendingSignatures: sigs, approvalWarning: '' });
    this.updateApprovalWarning();
  },

  // Open placement popup (called from "调整位置" button on pending signatures)
  openPlacement(e) {
    let idx = parseInt(e.currentTarget.dataset.sigIdx);
    this._openPlacementForIdx(idx);
  },

  // Load file preview (image or PDF page) from server
  async loadFilePreview(fileId, page) {
    let that = this;
    try {
      let res = await callFunction({
        name: 'getAuditFilePreview',
        data: { fileId: fileId, page: page || 1 }
      });
      if (res.status === 'success') {
        let updateData = {
          placementTotalPages: res.totalPages || 1,
          placementCurrentPage: res.page || 1,
          placementFileMime: res.mimeType || that.data.placementFileMime,
          placementLoading: false
        };
        if (res.data) {
          let previewDataUrl = 'data:' + (res.previewMime || 'image/png') + ';base64,' + res.data;
          try {
            updateData.placementFileImage = await that._dataUrlToTempFile(previewDataUrl, 'audit_file_preview');
          } catch (writeErr) {
            console.error('[audit] write preview temp file failed:', writeErr);
            updateData.placementFileImage = previewDataUrl;
          }
        } else if (res.fallback) {
          // No preview available — show placeholder
          updateData.placementFileImage = '';
        }
        that.setData(updateData);
      } else {
        that.setData({ placementLoading: false });
      }
    } catch (e) {
      console.error('[audit] loadFilePreview failed:', e);
      // Fall back to old method for images
      try {
        let fallbackRes = await callFunction({ name: 'getAuditFile', data: { fileId: fileId } });
        if (fallbackRes.status === 'success' && fallbackRes.mimeType && fallbackRes.mimeType.indexOf('image/') === 0) {
          let fallbackDataUrl = 'data:' + fallbackRes.mimeType + ';base64,' + fallbackRes.data;
          let fallbackSrc = fallbackDataUrl;
          try {
            fallbackSrc = await that._dataUrlToTempFile(fallbackDataUrl, 'audit_file_preview');
          } catch (writeErr) {
            console.error('[audit] write fallback preview temp file failed:', writeErr);
          }
          that.setData({
            placementFileImage: fallbackSrc,
            placementLoading: false
          });
        } else {
          that.setData({ placementLoading: false });
        }
      } catch (_) {
        that.setData({ placementLoading: false });
      }
    }
  },

  // Switch PDF page in placement preview
  onPlacementPageChange(e) {
    let direction = e.currentTarget.dataset.dir; // 'prev' or 'next'
    let newPage = this.data.placementCurrentPage;
    if (direction === 'prev') {
      newPage = Math.max(1, newPage - 1);
    } else {
      newPage = Math.min(this.data.placementTotalPages, newPage + 1);
    }
    if (newPage !== this.data.placementCurrentPage) {
      this.setData({
        placementCurrentPage: newPage,
        placementFileImage: '',
        placementLoading: true
      });
      this.loadFilePreview(this.data.placementFileId, newPage);
    }
  },

  // Legacy: load file for placement (called from openPlacement)
  async loadFileForPlacement(fileId) {
    try {
      let res = await callFunction({ name: 'getAuditFile', data: { fileId: fileId } });
      if (res.status === 'success' && res.mimeType && res.mimeType.indexOf('image/') === 0) {
        let dataUrl = 'data:' + res.mimeType + ';base64,' + res.data;
        let src = await this._dataUrlToTempFile(dataUrl, 'audit_file_preview').catch(function() { return dataUrl; });
        this.setData({ placementFileImage: src });
      }
    } catch (e) {
      // Non-fatal; placement works without image preview
    }
  },

  closePlacement() {
    // ★ 还原快照：本轮所有修改（位置/大小/旋转/新增副本）全部丢弃
    if (this._placementSnapshot) {
      this.setData({
        pendingSignatures: JSON.parse(JSON.stringify(this._placementSnapshot))
      });
      this._placementSnapshot = null;
      this.updateApprovalWarning();
    }
    this.setData({ placementVisible: false, placementAutoOpened: false });
  },

  onPlacementItemTap(e) {
    let idx = parseInt(e.currentTarget.dataset.sigIdx);
    let sigs = this.data.pendingSignatures || [];
    let sig = sigs[idx];
    if (!sig) return;

    let oldPage = this.data.placementCurrentPage;
    let px = sig.positionX != null ? sig.positionX : 0.5;
    let py = sig.positionY != null ? sig.positionY : 0.3;
    let page = sig.page || oldPage || 1;
    this.setData({
      placementActiveIdx: idx,
      placementType: sig.signatureType || this.data.placementType,
      placementPreviewX: px,
      placementPreviewY: py,
      placementSize: Math.round((sig.size || 1) * 100),
      placementRotation: sig.rotation || 0,
      placementCurrentPage: page,
      placementPosText: (px * 100).toFixed(1) + '%, ' + (py * 100).toFixed(1) + '%'
    });

    if (this.data.placementFileMime === 'application/pdf' && page !== oldPage) {
      this.setData({ placementFileImage: '', placementLoading: true });
      this.loadFilePreview(this.data.placementFileId, page);
    }
  },

  // Handle tap on placement canvas — update position relative to the preview image.
  // ★ Coordinates are unified to viewport (absolute) before computing the ratio,
  //    so scroll state and element nesting never cause drift.
  onPlacementTap(e) {
    let that = this;
    let point = that._getTapClientPoint(e);
    if (!point) return;

    // Step 1: get scroll-view rect to resolve element-relative coords
    wx.createSelectorQuery().select('#placementCanvas').boundingClientRect(function(canvasRect) {
      if (!canvasRect) return;

      // Step 2: unify to viewport-absolute CSS pixels
      let absX = point.isAbsolute ? point.x : (canvasRect.left + point.x);
      let absY = point.isAbsolute ? point.y : (canvasRect.top + point.y);

      // Step 3: get preview image rect (viewport-absolute)
      wx.createSelectorQuery().select('#placementPreviewImage').boundingClientRect(function(imgRect) {
        // Fallback to scroll-view if image not found (placeholder / loading)
        let ref = (imgRect && imgRect.width > 0) ? imgRect : canvasRect;

        let px = Math.max(0, Math.min(1, (absX - ref.left) / (ref.width || 1)));
        let py = Math.max(0, Math.min(1, (absY - ref.top) / (ref.height || 1)));
        that._applyPlacementPosition(px, py);
      }).exec();
    }).exec();
  },

  addPlacementCopy() {
    let baseIdx = this.data.placementActiveIdx;
    let sigs = [...(this.data.pendingSignatures || [])];
    let base = sigs[baseIdx];
    if (!base) {
      showShortToast(localeCopy.copy_32a2bb57fd);
      return;
    }

    let px = this.data.placementPreviewX >= 0
      ? this.data.placementPreviewX
      : (base.positionX != null ? base.positionX : 0.5);
    let py = this.data.placementPreviewY >= 0
      ? this.data.placementPreviewY
      : (base.positionY != null ? base.positionY : 0.3);
    let page = this.data.placementCurrentPage || base.page || 1;
    let newSig = Object.assign({}, base, {
      _idx: (base.signatureType || 'signature') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      positionX: px,
      positionY: py,
      size: base.size || (this.data.placementSize / 100) || 1,
      rotation: base.rotation != null ? base.rotation : (this.data.placementRotation || 0),
      page: page
    });
    newSig.posText = this._computeSigPosText(newSig);
    sigs.push(newSig);

    let newIdx = sigs.length - 1;
    let items = [...(this.data.placementItems || []), {
      dispIdx: newIdx,
      imageData: newSig.imageData,
      previewSrc: newSig.previewSrc || newSig.imageData || '',
      positionX: px,
      positionY: py,
      size: newSig.size,
      rotation: newSig.rotation,
      page: page,
      signatureType: newSig.signatureType
    }];

    this.setData({
      pendingSignatures: sigs,
      placementItems: items,
      placementActiveIdx: newIdx,
      placementType: newSig.signatureType || this.data.placementType,
      placementPreviewX: px,
      placementPreviewY: py,
      placementPosText: (px * 100).toFixed(1) + '%, ' + (py * 100).toFixed(1) + '%',
      approvalWarning: ''
    });

    this._preparePlacementItemPreviews(items).then((prepared) => {
      if (this.data.placementVisible) {
        this.setData({ placementItems: prepared });
      }
    });
    this.updateApprovalWarning();
  },

  // Extract tap/touch coordinates.
  // Returns {x, y, isAbsolute} where isAbsolute=true means viewport coords (clientX/Y),
  // isAbsolute=false means element-relative coords (e.detail.x/y from bindtap).
  _getTapClientPoint(e) {
    let touch = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (touch && Number.isFinite(Number(touch.clientX)) && Number.isFinite(Number(touch.clientY))) {
      return {
        x: Number(touch.clientX),
        y: Number(touch.clientY),
        isAbsolute: true   // clientX/Y are viewport-relative CSS pixels
      };
    }
    // bindtap events: e.detail.x/y are relative to the tapped element
    if (e.detail && e.detail.x != null && e.detail.y != null) {
      return { x: e.detail.x, y: e.detail.y, isAbsolute: false };
    }
    return null;
  },

  // Apply placement position to active signature
  _applyPlacementPosition(px, py) {
    let that = this;
    let normalizedX = Math.max(0, Math.min(1, Number(px) || 0));
    let normalizedY = Math.max(0, Math.min(1, Number(py) || 0));
    let idx = that.data.placementActiveIdx;
    let sigs = [...that.data.pendingSignatures];
    let items = [...that.data.placementItems];
    let page = that.data.placementCurrentPage;

    if (idx >= 0 && idx < sigs.length) {
      sigs[idx].positionX = normalizedX;
      sigs[idx].positionY = normalizedY;
      sigs[idx].page = page;
      sigs[idx].posText = this._computeSigPosText(sigs[idx]);
    }

    // Update placementItems for visual preview
    for (let i = 0; i < items.length; i++) {
      if (items[i].dispIdx === idx) {
        items[i].positionX = normalizedX;
        items[i].positionY = normalizedY;
        items[i].page = page;
        break;
      }
    }

    that.setData({
      placementPreviewX: normalizedX,
      placementPreviewY: normalizedY,
      placementPosText: (normalizedX * 100).toFixed(1) + '%, ' + (normalizedY * 100).toFixed(1) + '%',
      pendingSignatures: sigs,
      placementItems: items
    });
  },

  _applyPlacementTransform(size, rotation) {
    let idx = this.data.placementActiveIdx;
    let sigs = [...this.data.pendingSignatures];
    let items = [...this.data.placementItems];
    let safeSize = Math.max(0.5, Math.min(2.2, Number(size) || 1));
    let safeRotation = Math.max(-180, Math.min(180, Number(rotation) || 0));

    if (idx >= 0 && idx < sigs.length) {
      sigs[idx].size = safeSize;
      sigs[idx].rotation = safeRotation;
    }

    for (let i = 0; i < items.length; i++) {
      if (items[i].dispIdx === idx) {
        items[i].size = safeSize;
        items[i].rotation = safeRotation;
        break;
      }
    }

    this.setData({
      placementSize: Math.round(safeSize * 100),
      placementRotation: Math.round(safeRotation),
      pendingSignatures: sigs,
      placementItems: items
    });
  },

  onPlacementSizeChange(e) {
    this._applyPlacementTransform((Number(e.detail.value) || 100) / 100, this.data.placementRotation || 0);
  },

  onPlacementRotationChange(e) {
    this._applyPlacementTransform((this.data.placementSize || 100) / 100, Number(e.detail.value) || 0);
  },

  nudgePlacementRotation(e) {
    let delta = Number(e.currentTarget.dataset.delta) || 0;
    this._applyPlacementTransform((this.data.placementSize || 100) / 100, (this.data.placementRotation || 0) + delta);
  },

  resetPlacementTransform() {
    this._applyPlacementTransform(1, 0);
  },

  // Save the adjusted position and page
  confirmPlacement() {
    let idx = this.data.placementActiveIdx;
    let rawPx = Number(this.data.placementPreviewX);
    let rawPy = Number(this.data.placementPreviewY);
    let page = this.data.placementCurrentPage;
    if (idx < 0 || !Number.isFinite(rawPx) || !Number.isFinite(rawPy) || rawPx < 0 || rawPy < 0) {
      this._placementSnapshot = null;
      this.setData({ placementVisible: false, placementAutoOpened: false });
      return;
    }
    let px = Math.max(0, Math.min(1, rawPx));
    let py = Math.max(0, Math.min(1, rawPy));
    let sigs = [...this.data.pendingSignatures];
    if (idx < sigs.length) {
      sigs[idx].positionX = px;
      sigs[idx].positionY = py;
      sigs[idx].page = page;
      sigs[idx].size = (this.data.placementSize || 100) / 100;
      sigs[idx].rotation = this.data.placementRotation || 0;
      sigs[idx].posText = this._computeSigPosText(sigs[idx]);
    }
    this._placementSnapshot = null; // 确认保存，清除快照
    this.setData({
      pendingSignatures: sigs,
      placementVisible: false,
      placementAutoOpened: false
    });
  },

  _getApprovalMaterialWarning(actionType, signatures) {
    const sigs = signatures || [];
    const hasSignature = sigs.some(function(s) { return s.signatureType === 'signature'; });
    const hasStamp = sigs.some(function(s) { return s.signatureType === 'stamp'; });
    if (actionType === 'sign' && !hasSignature) return localeCopy.copy_a6f8fa4809;
    if ((actionType === 'estamp' || actionType === 'stamp') && !hasStamp) return localeCopy.copy_472d3dfdab;
    if (actionType === 'both') {
      if (!hasSignature && !hasStamp) return localeCopy.copy_448b029911;
      if (!hasSignature) return localeCopy.copy_a6f8fa4809;
      if (!hasStamp) return localeCopy.copy_472d3dfdab;
    }
    return '';
  },

  // Check if signature/stamp requirements are met and set warning
  updateApprovalWarning() {
    let actionType = this.data.activeApprovalStep ? this.data.activeApprovalStep.actionType : '';
    let warning = this._getApprovalMaterialWarning(actionType, this.data.pendingSignatures || []);
    if (warning !== this.data.approvalWarning) {
      this.setData({ approvalWarning: warning });
    }
  },

  // Toggle flow node detail expansion
  toggleFlowNode(e) {
    let key = e.currentTarget.dataset.nodeKey;
    let current = this.data.expandedNodeKey;
    this.setData({ expandedNodeKey: current === key ? '' : key });
  },

  // Direct approval from the inline approval card (no popup)
  async confirmApprovalDirect(e) {
    if (!this.ensureActiveAssignment()) return;
    let action = e.currentTarget.dataset.action;
    let stepId = this.data.activeApprovalStepId;
    let comment = this.data.approvalComment;
    let reason = this.data.rejectionReason;

    // Fallback: if activeApprovalStepId is not set, find the pending step from latest round
    if (!stepId) {
      let steps = this.data.steps || [];
      let submission = this.data.submission;
      if (submission && steps.length && submission.status === 'in_progress') {
        let maxRound = 0;
        for (let i = 0; i < steps.length; i++) maxRound = Math.max(maxRound, steps[i].round || 1);
        for (let i = 0; i < steps.length; i++) {
          if ((steps[i].round || 1) === maxRound &&
              steps[i].sortOrder === submission.currentStepIndex &&
              steps[i].status === 'pending') {
            stepId = steps[i].id;
            break;
          }
        }
      }
    }

    if (!stepId) {
      showShortToast(localeCopy.copy_29f31e5552);
      return;
    }
    if (action === 'reject' && !reason) {
      showShortToast(localeCopy.copy_3764af0483);
      return;
    }

    if (action === 'approve') {
      const actionType = this.data.activeApprovalStep ? this.data.activeApprovalStep.actionType : '';
      const warning = this._getApprovalMaterialWarning(actionType, this.data.pendingSignatures || []);
      if (warning) {
        this.setData({ approvalWarning: warning });
        showShortToast(warning);
        return;
      }
    }

    this.setData({ loading: true });
    try {
      let res;
      if (action === 'approve') {
        let designatedPersons = [...new Set((this.data.designatedNextPersons || []).map(function(p) { return p.id; }))];
        let designatedAssignments = (this.data.designatedNextPersons || []).map(function(p) { return p.assignmentId; });
        let sigs = (this.data.pendingSignatures || []).map(function(s) {
          const material = {
            fileId: s.fileId,
            signatureType: s.signatureType,
            positionX: s.positionX,
            positionY: s.positionY,
            size: s.size || 1,
            rotation: s.rotation || 0,
            page: s.page || 1
          };
          if (s.signatureType === 'stamp') {
            material.stampId = s.stampId;
          } else {
            material.imageData = s.imageData;
          }
          return material;
        });
        res = await callFunction({
          name: 'approveStep',
          data: {
            submissionId: this.data.submissionId,
            stepId: stepId,
            comment: comment,
            signatures: sigs,
            designatedNextPersonIds: designatedPersons,
            designatedNextAssignmentIds: designatedAssignments
          }
        });
      } else {
        res = await callFunction({
          name: 'rejectStep',
          data: { submissionId: this.data.submissionId, stepId: stepId, rejectionReason: reason }
        });
      }

      if (res.status === 'success') {
        showShortToast(res.message || localeCopy.copy_2220286f1c);
        this.setData({ approvalComment: '', rejectionReason: '', designatedNextPersons: [], nextStepInfo: null });
        require('../../../../utils/eventBus').emit('approval:done');
        this.loadDetail();
      } else {
        if (!this.handleWorkContextFailure(res)) {
          showShortToast(res.message || localeCopy.copy_0531ed9e78);
        }
      }
    } catch (err) {
      if (!this.handleWorkContextFailure(err)) {
        showShortToast(getErrorText(err, localeCopy.copy_0531ed9e78));
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  // ═══════════════════════════════════════════════
  // Edit Mode (for draft/pending/rejected/withdrawn)
  // ═══════════════════════════════════════════════

  // Check if submission is editable
  isEditableStatus(status) {
    return status === 'draft' || status === 'pending' || status === 'rejected' || status === 'withdrawn';
  },

  _getExistingTemplateStepOverrides(steps) {
    const source = Array.isArray(steps) ? steps : [];
    const latestRound = source.reduce(function(maxRound, step) {
      return Math.max(maxRound, Number(step.round) || 1);
    }, 1);
    const firstStep = source.find(function(step) {
      return (Number(step.round) || 1) === latestRound &&
        Number(step.sortOrder) === 1 && step.allowApproverDesignation === true;
    });
    if (!firstStep) return [];

    let conditions = [];
    try {
      conditions = firstStep.stepConditionsJson ? JSON.parse(firstStep.stepConditionsJson) : [];
    } catch (_) {
      conditions = [];
    }
    if (!Array.isArray(conditions) || !conditions.length || !conditions.every(function(condition) {
      return condition && condition.conditionType === 'person';
    })) {
      return [{ stepIndex: 1, personHrIds: [], personHrNames: [], assignmentIds: [], assignmentViews: [] }];
    }

    const personHrIds = [];
    const assignmentIds = [];
    conditions.forEach(function(condition) {
      String(condition.personHrIds || '').split(',').map(function(id) { return id.trim(); })
        .filter(Boolean).forEach(function(id) {
          if (personHrIds.indexOf(id) < 0) personHrIds.push(id);
        });
      String(condition.assignmentIds || '').split(',').map(function(id) { return id.trim(); })
        .filter(Boolean).forEach(function(id) {
          if (assignmentIds.indexOf(id) < 0) assignmentIds.push(id);
        });
    });
    return [{
      stepIndex: 1,
      personHrIds: personHrIds,
      personHrNames: [],
      assignmentIds: assignmentIds,
      assignmentViews: []
    }];
  },

  enterEditMode() {
    let submission = this.data.submission;
    let files = this.data.files || [];
    let steps = this.data.steps || [];

    if (!this.isEditableStatus(submission.status)) {
      showShortToast(localeCopy.copy_92c9f0b2b4);
      return;
    }

    // Load reference data if not loaded
    if (!this.data.allIdentities.length && !this.data.allDepartments.length) {
      this.loadReferenceData();
    }

    const existingTemplateOverrides = submission.type === 'template'
      ? this._getExistingTemplateStepOverrides(steps)
      : [];
    this.setData({
      editMode: true,
      editTitle: submission.title || '',
      editDesc: submission.description || '',
      editType: submission.type || 'template',
      editResubmitMode: submission.resubmitMode || 'fresh',
      editTemplateId: submission.templateId || '',
      templatePreviewSteps: [],
      templateStepOverrides: existingTemplateOverrides,
      editSteps: submission.type === 'ad_hoc' ? steps.map(function(s) {
        return {
          name: s.stepName || s.name || '',
          approverType: s.approverType || 'identity',
          approverHrId: s.approverHrId || '',
          approverHrName: s.approverName || '',
          approverAssignmentId: s.approverAssignmentId || '',
          approverAssignmentLabel: s.approverAssignmentLabel || '',
          approverIdentityId: s.approverIdentityId || '',
          approverIdentityName: s.approverIdentityName || '',
          actionType: s.actionType || 'pass',
          scopeType: s.scopeType || 'all',
          scopeDepartmentId: s.scopeDepartmentId || '',
          scopeDepartmentName: s.scopeDepartmentName || '',
          scopeWorkGroupId: s.scopeWorkGroupId || '',
          scopeWorkGroupName: s.scopeWorkGroupName || '',
          // Include conditions for multi-select / OR display
          stepConditionsJson: s.stepConditionsJson || null,
          stepConditionsDisplay: s.stepConditionsDisplay || [],
          approverDesc: s.approverDesc || ''
        };
      }) : [],
      editFiles: files,
      editNewFiles: []
    });
    if (submission.type === 'template' && submission.templateId) {
      this.loadTemplatePreview(submission.templateId, existingTemplateOverrides);
    }
  },

  cancelEdit() {
    this.setData({ editMode: false });
  },

  onEditTitleInput(e) {
    this.setData({ editTitle: e.detail.value });
  },

  onEditDescInput(e) {
    this.setData({ editDesc: e.detail.value });
  },

  onEditTypeChange(e) {
    const editType = e.currentTarget.dataset.type;
    this.setData({ editType: editType });
    if (editType === 'template' && this.data.editTemplateId) {
      this.loadTemplatePreview(this.data.editTemplateId, this.data.templateStepOverrides);
    }
  },

  onEditResubmitModeChange(e) {
    this.setData({ editResubmitMode: ['fresh', 'from_rejector'][e.detail.value] || 'fresh' });
  },

  // ── Edit: Ad-hoc step editor ──

  openEditStepEditor() {
    this.setData({
      editStepEditorVisible: true,
      editStepForm: { name: '', approverType: 'identity', approverIdentityId: '', approverIdentityName: '', approverHrId: '', approverHrName: '', actionType: 'pass', scopeType: 'all', scopeDepartmentId: '', scopeDepartmentName: '', scopeWorkGroupId: '', scopeWorkGroupName: '' },
      editIdentityPickerScopeIndex: 0,
      editIdentityPickerDeptIndex: 0,
      editIdentityPickerWgIndex: 0,
      editIdentityPickerIdentIndex: 0
    });
  },

  closeEditStepEditor() {
    this.setData({ editStepEditorVisible: false, editPersonPickerVisible: false });
  },

  onEditStepFieldInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['editStepForm.' + field]: e.detail.value });
  },

  onEditStepTypeChange(e) {
    let type = ['identity', 'specific_person'][e.detail.value] || 'identity';
    this.setData({
      'editStepForm.approverType': type,
      'editStepForm.approverIdentityId': '',
      'editStepForm.approverIdentityName': '',
      'editStepForm.approverHrId': '',
      'editStepForm.approverHrName': ''
    });
  },

  onEditActionTypeChange(e) {
    let val = ['pass', 'sign', 'estamp', 'both'][e.detail.value] || 'pass';
    this.setData({ 'editStepForm.actionType': val });
  },

  onEditIdentityScopeChange(e) { this.setData({ editIdentityPickerScopeIndex: parseInt(e.detail.value) }); },
  onEditIdentityDeptChange(e) { this.setData({ editIdentityPickerDeptIndex: parseInt(e.detail.value) }); },
  onEditIdentityWgChange(e) { this.setData({ editIdentityPickerWgIndex: parseInt(e.detail.value) }); },
  onEditIdentityIdentChange(e) { this.setData({ editIdentityPickerIdentIndex: parseInt(e.detail.value) }); },

  confirmEditIdentityStep() {
    let sf = this.data.editStepForm;
    let identities = this.data.allIdentities;
    let departments = this.data.allDepartments;
    let workGroups = this.data.allWorkGroups;
    let identIdx = this.data.editIdentityPickerIdentIndex;
    let identOpts = this.data.identityPickerIdentOptions;
    let scopeIdx = this.data.editIdentityPickerScopeIndex;
    let scopeValues = this.data.identityPickerScopeValues;

    if (identIdx <= 0) { showShortToast(localeCopy.copy_d1856227b6); return; }
    let identName = identOpts[identIdx];
    let identity = identities.find(function(i) { return i.name === identName; });
    if (!identity) { showShortToast(localeCopy.copy_10d3269bb4); return; }

    let scopeType = scopeValues[scopeIdx] || 'all';
    let scopeDepartmentId = '', scopeDepartmentName = '', scopeWorkGroupId = '', scopeWorkGroupName = '';

    if (scopeType === 'specific_department' || scopeType === 'specific_work_group') {
      let deptIdx = this.data.editIdentityPickerDeptIndex;
      let deptOpts = this.data.identityPickerDeptOptions;
      if (deptIdx <= 0) { showShortToast(localeCopy.copy_eada426deb); return; }
      let deptName = deptOpts[deptIdx];
      let dept = departments.find(function(d) { return d.name === deptName; });
      if (!dept) { showShortToast(localeCopy.copy_9f09d6a2b3); return; }
      scopeDepartmentId = dept.id;
      scopeDepartmentName = dept.name;
    }
    if (scopeType === 'specific_work_group') {
      let wgIdx = this.data.editIdentityPickerWgIndex;
      let wgOpts = this.data.identityPickerWgOptions;
      if (wgIdx <= 0) { showShortToast(localeCopy.copy_ec3b03ecc7); return; }
      let wgName = wgOpts[wgIdx];
      let wg = workGroups.find(function(w) { return w.name === wgName; });
      if (!wg) { showShortToast(localeCopy.copy_c4f6a0088b); return; }
      scopeWorkGroupId = wg.id;
      scopeWorkGroupName = wg.name;
    }

    let steps = [...this.data.editSteps];
    steps.push({
      name: (sf.name || '').trim(),
      approverType: 'identity',
      approverIdentityId: identity.id,
      approverIdentityName: identity.name,
      approverHrId: '',
      approverHrName: '',
      actionType: sf.actionType,
      scopeType: scopeType,
      scopeDepartmentId: scopeDepartmentId,
      scopeDepartmentName: scopeDepartmentName,
      scopeWorkGroupId: scopeWorkGroupId,
      scopeWorkGroupName: scopeWorkGroupName
    });

    this.setData({
      editSteps: steps,
      editStepEditorVisible: false,
      editStepForm: { name: '', approverType: 'identity', approverIdentityId: '', approverIdentityName: '', approverHrId: '', approverHrName: '', actionType: 'pass', scopeType: 'all', scopeDepartmentId: '', scopeDepartmentName: '', scopeWorkGroupId: '', scopeWorkGroupName: '' }
    });
  },

  // ── Edit: Person picker ──

  async openEditPersonPicker() {
    if (!this.ensureActiveAssignment()) return;
    this.setData({
      editPersonPickerVisible: true,
      editPersonPickerLoading: true,
      editPersonPickerDept: localeCopy.copy_31d4595959,
      editPersonPickerIdent: localeCopy.copy_31d4595959,
      editPersonPickerWg: localeCopy.copy_31d4595959,
      editPersonPickerKeyword: '',
      editPersonPickerSelectedIds: [],
      editPersonPickerSelectedList: [],
      editPersonPickerStepActionType: 'pass'
    });
    let persons = [];
    try {
      const res = await callFunction({ name: 'listEligibleApprovers', data: { all: true } });
      if (res.status === 'success') {
        persons = this._normalizeApproverList(res.approvers || []);
      } else {
        this.handleWorkContextFailure(res);
      }
    } catch (error) {
      console.error('[audit] listEligibleApprovers (edit) failed:', error);
    }
    this._updatePersonPickerOptions(persons);
    this.setData({ allHrPersons: persons, editPersonPickerLoading: false });
    this.applyEditPersonPickerFilters();
  },

  closeEditPersonPicker() { this.setData({ editPersonPickerVisible: false, editPersonPickerLoading: false }); },

  confirmSharedEditPersonPicker(e) {
    const detail = e.detail || {};
    this.setData({
      editPersonPickerSelectedIds: Array.isArray(detail.keys) ? detail.keys : [],
      editPersonPickerSelectedList: Array.isArray(detail.items) ? detail.items : []
    }, () => this.confirmEditPersonPicker());
  },

  onEditPersonPickerDeptChange(e) {
    let opts = this.data.personPickerDeptOpts;
    this.setData({ editPersonPickerDept: opts[parseInt(e.detail.value)] || localeCopy.copy_31d4595959 });
    this.applyEditPersonPickerFilters();
  },

  onEditPersonPickerIdentChange(e) {
    let opts = this.data.personPickerIdentOpts;
    this.setData({ editPersonPickerIdent: opts[parseInt(e.detail.value)] || localeCopy.copy_31d4595959 });
    this.applyEditPersonPickerFilters();
  },

  onEditPersonPickerWgChange(e) {
    let opts = this.data.personPickerWgOpts;
    this.setData({ editPersonPickerWg: opts[parseInt(e.detail.value)] || localeCopy.copy_31d4595959 });
    this.applyEditPersonPickerFilters();
  },

  onEditPersonPickerSearch(e) {
    this.setData({ editPersonPickerKeyword: e.detail.value });
    this.applyEditPersonPickerFilters();
  },

  applyEditPersonPickerFilters() {
    let list = [...this.data.allHrPersons];
    let dept = this.data.editPersonPickerDept;
    let ident = this.data.editPersonPickerIdent;
    let wg = this.data.editPersonPickerWg;
    let kw = (this.data.editPersonPickerKeyword || '').trim().toLowerCase();

    list = list.map(function(person) {
      return workContextView.filterCandidateAssignments(person, {
        department: dept === localeCopy.copy_31d4595959 ? '' : dept,
        identityCategory: ident === localeCopy.copy_31d4595959 ? '' : ident,
        workGroup: wg === localeCopy.copy_31d4595959 ? '' : wg,
        keyword: kw
      });
    }).filter(Boolean);

    let selectedIds = this.data.editPersonPickerSelectedIds;
    let candidates = this._decorateAssignmentSelection(list, selectedIds);
    let selectedList = this._selectedAssignmentViews(this.data.allHrPersons, selectedIds);

    this.setData({ editPersonPickerCandidates: candidates, editPersonPickerSelectedList: selectedList });
  },

  onEditPersonToggle(e) {
    let assignmentId = String(e.currentTarget.dataset.assignmentId || '');
    if (!assignmentId) return;
    let sel = [...this.data.editPersonPickerSelectedIds];
    let idx = sel.indexOf(assignmentId);
    if (idx >= 0) sel.splice(idx, 1); else sel.push(assignmentId);
    this.setData({ editPersonPickerSelectedIds: sel });
    this.applyEditPersonPickerFilters();
  },

  onEditPersonPickerActionTypeChange(e) {
    this.setData({ editPersonPickerStepActionType: ['pass', 'sign', 'estamp', 'both'][e.detail.value] || 'pass' });
  },

  confirmEditPersonPicker() {
    let selected = this.data.editPersonPickerSelectedList;
    if (!selected.length) { showShortToast(localeCopy.copy_b66608a15f); return; }
    let steps = [...this.data.editSteps];
    let actionType = this.data.editPersonPickerStepActionType;
    for (let i = 0; i < selected.length; i++) {
      let p = selected[i];
      steps.push({
        name: (this.data.editStepForm.name || '').trim() || (p.name + localeCopy.copy_c9695bb971),
        approverType: 'specific_person',
        approverHrId: p.id,
        approverHrName: p.name,
        approverAssignmentId: p.assignmentId,
        approverAssignmentLabel: p.assignmentLabel,
        approverDesc: p.name + ' · ' + p.assignmentLabel,
        approverIdentityId: '',
        approverIdentityName: '',
        actionType: actionType,
        conditions: [{
          conditionType: 'person',
          personHrIds: p.id,
          assignmentIds: p.assignmentId
        }]
      });
    }
    this.setData({ editSteps: steps, editPersonPickerVisible: false });
  },

  removeEditStep(e) {
    let idx = e.currentTarget.dataset.index;
    let steps = [...this.data.editSteps];
    steps.splice(idx, 1);
    this.setData({ editSteps: steps });
  },

  // ── Edit: File management ──

  editChooseFile() {
    let that = this;
    wx.chooseMessageFile({
      count: 3,
      type: 'file',
      success: function(res) { that.uploadEditFiles(res.tempFiles); }
    });
  },

  editChooseImage() {
    let that = this;
    wx.chooseImage({
      count: 3,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success: function(res) {
        let tempFiles = res.tempFilePaths.map(function(p, i) {
          return { path: p, name: 'image_' + Date.now() + '_' + i + '.jpg', size: res.tempFiles ? (res.tempFiles[i] ? res.tempFiles[i].size : 0) : 0 };
        });
        that.uploadEditFiles(tempFiles);
      }
    });
  },

  async uploadEditFiles(tempFiles) {
    if (!tempFiles || !tempFiles.length) return;
    this.setData({ editUploading: true });
    let newFiles = [...this.data.editNewFiles];
    let firstError = '';
    for (let i = 0; i < tempFiles.length; i++) {
      let tf = tempFiles[i];
      try {
        let base64 = await new Promise(function(resolve, reject) {
          wx.getFileSystemManager().readFile({
            filePath: tf.path, encoding: 'base64',
            success: function(r) { resolve(r.data); },
            fail: function(err) { reject(err); }
          });
        });
        let fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        let validation = this.validateAuditUploadFile(tf.name, tf.size || 0, base64);
        if (!validation.ok) {
          throw new Error((tf.name || localeCopy.copy_afad9f1b56) + ': ' + validation.message);
        }
        newFiles.push({
          fileId: fileId, fileName: tf.name || 'unknown',
          mimeType: validation.mimeType,
          fileSize: tf.size || 0, fileHash: '', tmpPath: tf.path, base64: base64
        });
      } catch (e) {
        if (!firstError) firstError = getErrorText(e, localeCopy.copy_03d69a9d28);
        console.error(localeCopy.copy_e4882ec81b, tf.name, e);
      }
    }
    if (firstError && newFiles.length === this.data.editNewFiles.length) {
      showShortToast(firstError);
    }
    this.setData({ editNewFiles: newFiles, editUploading: false });
  },

  removeEditFile(e) {
    let idx = e.currentTarget.dataset.index;
    let files = [...this.data.editFiles];
    files.splice(idx, 1);
    this.setData({ editFiles: files });
  },

  removeEditNewFile(e) {
    let idx = e.currentTarget.dataset.index;
    let files = [...this.data.editNewFiles];
    files.splice(idx, 1);
    this.setData({ editNewFiles: files });
  },

  async saveEdit() {
    if (!this.ensureActiveAssignment()) return;
    let _editTitle = this.data.editTitle;
    if (!_editTitle) { showShortToast(localeCopy.copy_b99e01d38c); return; }

    this.setData({ loading: true });

    try {
      // Upload new files first
      let serverNewFiles = [];
      let editNewFiles = this.data.editNewFiles;
      for (let i = 0; i < editNewFiles.length; i++) {
        let uf = editNewFiles[i];
        let uploadRes = await callFunction({
          name: 'uploadAuditFile',
          data: { fileBase64: uf.base64, fileName: uf.fileName, mimeType: uf.mimeType }
        });
        if (uploadRes.status === 'success') {
          serverNewFiles.push({
            fileId: uploadRes.fileId, fileName: uploadRes.fileName,
            mimeType: uploadRes.mimeType, fileSize: uploadRes.fileSize,
            fileHash: uploadRes.fileHash,
            fileToken: uploadRes.fileToken
          });
        } else {
          throw new Error(uploadRes.message || localeCopy.copy_060a64d6e7);
        }
      }

      // Build steps data
      let stepsData = null;
      if (this.data.editType === 'ad_hoc' && this.data.editSteps.length) {
        stepsData = this.data.editSteps.map(function(s) {
          let conditions = Array.isArray(s.conditions) ? s.conditions : [];
          if (!conditions.length && s.stepConditionsJson) {
            try {
              const parsed = JSON.parse(s.stepConditionsJson);
              if (Array.isArray(parsed)) conditions = parsed;
            } catch (_) {}
          }
          return {
            name: s.name || '',
            approverType: s.approverType,
            approverIdentityId: s.approverIdentityId || '',
            approverHrId: s.approverHrId || '',
            approverAssignmentId: s.approverAssignmentId || '',
            actionType: s.actionType || 'pass',
            scopeType: s.scopeType || 'all',
            scopeDepartmentId: s.scopeDepartmentId || '',
            scopeWorkGroupId: s.scopeWorkGroupId || '',
            conditions: conditions
          };
        });
      }

      const retainedFileIds = (this.data.editFiles || []).map(function(file) {
        return file.id || file.fileId || '';
      }).filter(Boolean);
      if (retainedFileIds.length + serverNewFiles.length < 1) {
        showShortToast(localeCopy.copy_88218650ba);
        return;
      }
      const stepOverrides = this.data.editType === 'template'
        ? (this.data.templateStepOverrides || []).filter(function(item) {
          return Array.isArray(item.personHrIds) && item.personHrIds.length
            && Array.isArray(item.assignmentIds) && item.assignmentIds.length;
        }).map(function(item) {
          return { stepIndex: item.stepIndex, personHrIds: item.personHrIds, assignmentIds: item.assignmentIds };
        })
        : [];

      let res = await callFunction({
        name: 'updateAuditSubmission',
        data: {
          submissionId: this.data.submissionId,
          title: _editTitle,
          description: this.data.editDesc,
          type: this.data.editType,
          templateId: this.data.editTemplateId || '',
          resubmitMode: this.data.editResubmitMode,
          stepOverrides: stepOverrides,
          steps: stepsData,
          files: serverNewFiles,
          retainedFileIds: retainedFileIds
        }
      });

      if (res.status === 'success') {
        showShortToast(localeCopy.copy_3315a98bd6);
        this.setData({ editMode: false });
        this.loadDetail();
      } else {
        if (!this.handleWorkContextFailure(res)) {
          showShortToast(res.message || localeCopy.copy_215e3c57da);
        }
      }
    } catch (e) {
      if (!this.handleWorkContextFailure(e)) {
        showShortToast(getErrorText(e, localeCopy.copy_215e3c57da));
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  // Resubmit after rejection
  async resubmit() {
    if (!this.ensureActiveAssignment()) return;
    this.setData({ loading: true });
    try {
      const stepOverrides = this.data.submission && this.data.submission.type === 'template'
        ? (this.data.templateStepOverrides || []).filter(function(item) {
          return Array.isArray(item.personHrIds) && item.personHrIds.length
            && Array.isArray(item.assignmentIds) && item.assignmentIds.length;
        }).map(function(item) {
          return { stepIndex: item.stepIndex, personHrIds: item.personHrIds, assignmentIds: item.assignmentIds };
        })
        : [];
      const res = await callFunction({
        name: 'resubmitAudit',
        data: { submissionId: this.data.submissionId, stepOverrides: stepOverrides }
      });
      if (res.status === 'success') {
        showShortToast(res.message || localeCopy.copy_e3f95790ae);
        this.loadDetail();
      } else {
        if (!this.handleWorkContextFailure(res)) {
          showShortToast(res.message || localeCopy.copy_e6f444764d);
        }
      }
    } catch (e) {
      if (!this.handleWorkContextFailure(e)) {
        showShortToast(getErrorText(e, localeCopy.copy_e6f444764d));
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  // ── File preview ──
  previewFile(e) {
    const fileId = e.currentTarget.dataset.fileId;
    const fileName = e.currentTarget.dataset.fileName || '';
    if (!fileId) return;
    openAuditFile({ fileId: fileId, fileName: fileName });
  },

  // Withdraw
  async withdraw() {
    if (!this.ensureActiveAssignment()) return;
    const that = this;
    wx.showModal({
      title: localeCopy.copy_9a766011a1,
      content: localeCopy.copy_68e750360c,
      success: async (modalRes) => {
        if (!modalRes.confirm) return;
        try {
          const res = await callFunction({
            name: 'withdrawSubmission',
            data: { submissionId: that.data.submissionId }
          });
          if (res.status === 'success') {
            showShortToast(localeCopy.copy_282e15e226);
            wx.navigateBack();
          } else {
            if (!that.handleWorkContextFailure(res)) {
              showShortToast(res.message || localeCopy.copy_14ebfed982);
            }
          }
        } catch (e) {
          if (!that.handleWorkContextFailure(e)) {
            showShortToast(getErrorText(e, localeCopy.copy_14ebfed982));
          }
        }
      }
    });
  }
});
