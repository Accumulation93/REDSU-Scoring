const localeCopy = require('../../../../../locales/zh-CN/generated/subpackages/scoring/pages/admin/modules/auditBehavior');
/**
 * Audit Workflow Behavior — Admin-side audit management
 *
 * Tabs: auditTemplates | auditStamps | auditSubmissions | auditVerification
 */
const utils = require('./adminUtils');
const { formatAuditTime } = require('../../../../../utils/api');
const { openAuditFile } = require('../../../../../utils/filePreview');
const {
  verificationCopy,
  presentVerificationResponse,
  buildMatchVerificationParams
} = require('../../../../../utils/auditVerification');
const orgSession = require('../../../../../utils/orgSession');
const {
  ALL_FILTER_KEY,
  buildAuditPersonnelFilterOptions,
  filterAuditPersonnel
} = require('./auditPersonnelView');
const { showShortToast, getErrorText } = utils;

const AUDIT_PERSONNEL_RENDER_LIMIT = 80;

module.exports = Behavior({
  data: {
    verificationCopy,
    // ── Audit Flow Templates ──
    auditFlowTemplates: [],
    auditTemplateForm: {
      id: '',
      name: '',
      description: '',
      starterType: 'self',
      starterIdentityId: '',
      starterIdentityName: '',
      starterHrId: '',
      starterHrName: '',
      starterConditions: [],   // multi-condition starter OR-ed
      resubmitMode: 'fresh',
      steps: []
    },
    auditTemplateStepForm: {
      name: '',
      conditions: [],          // 指定人员条件同时保存 personHrIds 与 assignmentIds
      actionType: 'sign',
      allowApproverDesignation: false,
      editingIndex: -1
    },
    auditTemplateStepEditorVisible: false,

    // ── Step Condition Editor (sub-editor within step popup) ──
    auditStepConditionEditorVisible: false,
    auditStepConditionForm: {
      conditionType: 'identity_scope',  // 'identity_scope' | 'person'
      // identity scope fields
      departmentScope: 'all', specificDepartmentId: '', specificDepartmentName: '',
      workGroupScope: 'all', specificWorkGroupId: '', specificWorkGroupName: '',
      identityScope: 'all', specificIdentityId: '', specificIdentityName: '',
      // person fields
      personHrIds: '', personHrNames: '', assignmentIds: '', assignmentNames: ''
    },
    auditStepConditionEditingIndex: -1, // -1 = new, >=0 = editing existing
    _auditConditionTarget: 'step',       // 'step' | 'starter' — which conditions array is being edited

    // ── Starter Condition Editor ──
    auditStarterConditionEditorVisible: false,
    auditStarterConditionForm: {
      conditionType: 'identity_scope',
      departmentScope: 'all', specificDepartmentId: '', specificDepartmentName: '',
      workGroupScope: 'all', specificWorkGroupId: '', specificWorkGroupName: '',
      identityScope: 'all', specificIdentityId: '', specificIdentityName: '',
      personHrIds: '', personHrNames: '', assignmentIds: '', assignmentNames: ''
    },
    auditStarterConditionEditingIndex: -1,

    // ── Unified Multi-Select Picker (replaces personnel + identity pickers) ──
    auditMultiPickerVisible: false,
    auditMultiPickerTarget: '',          // 'personHr'|'department'|'workGroup'|'identity'
    auditMultiPickerTitle: '',
    auditMultiPickerItems: [],           // [{id, name, extra}]
    auditMultiPickerSelectedIds: {},     // {id: true}
    auditMultiPickerSearchKeyword: '',
    auditMultiPickerFilterDept: localeCopy.copy_31d4595959,
    auditMultiPickerFilterIdent: localeCopy.copy_31d4595959,
    auditMultiPickerFilteredList: [],
    auditMultiPickerDeptOptions: [localeCopy.copy_31d4595959],
    auditMultiPickerIdentOptions: [localeCopy.copy_31d4595959],
    // Department tabs for work group picker (when specific depts are selected)
    auditMultiPickerDeptTabs: [],
    auditMultiPickerActiveDeptTab: '',

    // ── Stamps ──
    stamps: [],
    stampForm: { id: '', name: '', imageData: '' },
    stampAssignIdentityId: '',
    stampAssignVisible: false,
    stampAssignSelectedIds: [],

    // ── Audit Submissions ──
    auditSubmissions: [],
    auditSubmissionFilters: { status: '' },
    auditSubmissionDetail: null,
    auditSubmissionDetailVisible: false,

    // ── Verification ──
    verificationPermissions: [],
    verificationGrantHrId: '',
    verificationGrantHrName: '',
    verificationResult: null,
    verificationMode: 'number',    // 'number' | 'file'
    verificationInputNumber: '',
    verificationInputId: '',
    verificationFileName: '',
    verificationFilePath: '',
    verificationFileBase64: '',
    verificationFileSize: 0,

    // ── Personnel Picker (unified, single-select) ──
    auditPersonnelPickerVisible: false,
    auditPersonnelPickerTarget: '',
    auditPersonnelPickerLabel: '',
    auditPersonnelPickerSelectedId: '',
    auditPersonnelSearchKeyword: '',
    auditPersonnelFilterDeptIndex: 0,
    auditPersonnelFilterIdentIndex: 0,
    auditPersonnelFilterWorkGroupIndex: 0,
    auditPersonnelDeptOptions: [{ key: ALL_FILTER_KEY, label: localeCopy.copy_31d4595959 }],
    auditPersonnelIdentOptions: [{ key: ALL_FILTER_KEY, label: localeCopy.copy_31d4595959 }],
    auditPersonnelWorkGroupOptions: [{ key: ALL_FILTER_KEY, label: localeCopy.copy_31d4595959 }],
    auditPersonnelFilteredList: [],

    // ── Identity Picker (single / multi) ──
    auditIdentityPickerVisible: false,
    auditIdentityPickerTarget: '',
    auditIdentityPickerLabel: '',
    auditIdentityPickerMulti: false,
    auditIdentityPickerSelectedIds: {},
    auditIdentityPickerSelectedCount: 0,

    // ── Template step expand/collapse ──
    auditExpandedTemplateId: '',
  },

  methods: {
    // ═══════════════════════════════════════════════════════
    // Shared helpers
    // ═══════════════════════════════════════════════════════

    /** Derive display name from identityList by id — NEVER returns raw ID */
    _auditIdentityName(id) {
      if (!id) return '';
      const found = (this.data.identityList || []).find(function (item) {
        return String(item.id) === String(id);
      });
      return found ? found.name : '';
    },

    /** Derive display name from hrList by id — NEVER returns raw ID */
    _auditHrName(id) {
      if (!id) return '';
      const found = (this._hrList || []).find(function (item) {
        return String(item.id) === String(id);
      });
      return found ? found.name : '';
    },

    /** 指定人员条件按具体在职岗位选择，禁止退化为人员级授权。 */
    _auditAssignmentOptions() {
      const options = [];
      (this._hrList || []).forEach(function (person) {
        (person.assignments || []).forEach(function (assignment) {
          const assignmentId = String(assignment.assignmentId || '').trim();
          if (!assignmentId) return;
          const label = String(assignment.assignmentLabel || '').trim();
          options.push({
            id: assignmentId,
            hrId: String(person.id || ''),
            name: person.name || '',
            assignmentLabel: label,
            extra: [person.studentId, label].filter(Boolean).join(' · '),
            deptId: String(assignment.departmentId || ''),
            identId: String(assignment.identityCategoryId || assignment.identityId || '')
          });
        });
      });
      return options;
    },

    _auditAssignmentName(id) {
      const found = this._auditAssignmentOptions().find(function (item) {
        return String(item.id) === String(id);
      });
      return found ? [found.name, found.assignmentLabel].filter(Boolean).join(' · ') : '';
    },

    /** Derive display name from departmentList by id — NEVER returns raw ID */
    _auditDeptName(id) {
      if (!id) return '';
      const found = (this.data.departmentList || []).find(function (item) {
        return String(item.id) === String(id);
      });
      return found ? found.name : '';
    },

    /** Derive display name from workGroupList by id — NEVER returns raw ID */
    _auditWgName(id) {
      if (!id) return '';
      const found = (this.data.workGroupList || []).find(function (item) {
        return String(item.id) === String(id);
      });
      return found ? found.name : '';
    },

    /** Build department options for personnel picker */
    _auditBuildDeptOptions() {
      const depts = this.data.departmentList || [];
      return [localeCopy.copy_31d4595959].concat(depts.map(function (d) { return d.name; }));
    },

    /** Build identity options for personnel picker */
    _auditBuildIdentOptions() {
      const idents = this.data.identityList || [];
      return [localeCopy.copy_31d4595959].concat(idents.map(function (i) { return i.name; }));
    },

    // ═══════════════════════════════════════════════════════
    // Audit Flow Templates
    // ═══════════════════════════════════════════════════════

    async loadAuditFlowTemplates() {
      const request = orgSession.beginRequest(this, 'auditFlowTemplates');
      this.setLoading('auditTemplates', true);
      try {
        const res = await this.callCloud('listAuditFlowTemplates', {});
        if (!orgSession.isRequestCurrent(this, request)) return;
        if (res.status === 'success') {
          let that = this;
          let templates = (res.templates || []).map(function (t) {
            t.steps = (t.steps || []).map(function (s) {
              // Always resolve names from master lists
              s._approverIdentityName = that._auditIdentityName(s.approverIdentityId);
              s._approverHrName = that._auditHrName(s.approverHrId);
              // Resolve conditions with display names
              if (s.conditions && s.conditions.length) {
                s._resolvedConditions = s.conditions.map(function (c) {
                  return that._auditResolveCondition(c);
                });
              } else {
                s._resolvedConditions = [];
              }
              // Build condition summary
              s._conditionSummary = that._auditConditionSummary(s.conditions && s.conditions[0] ? s.conditions[0] : null);
              return s;
            });
            return t;
          });
          this.setData({ auditFlowTemplates: templates });
        } else {
          console.error('[audit] listAuditFlowTemplates failed:', res.message);
        }
      } catch (e) {
        if (!orgSession.isRequestCurrent(this, request) || (e && e.silent)) return;
        console.error('[audit] loadAuditFlowTemplates error:', e);
        this.setData({ auditFlowTemplates: [] });
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setLoading('auditTemplates', false);
      }
    },

    onAuditTemplateFieldInput(e) {
      const field = e.currentTarget.dataset.field;
      const value = e.detail.value;
      this.setData({ ['auditTemplateForm.' + field]: value });
    },

    onAuditTemplateStepField(e) {
      const field = e.currentTarget.dataset.field;
      const value = e.detail.value;
      this.setData({ ['auditTemplateStepForm.' + field]: value });
    },

    startCreateAuditTemplate() {
      this.setData({
        auditTemplateForm: {
          id: '', name: '', description: '',
          starterType: 'conditions',
          starterIdentityId: '', starterIdentityName: '',
          starterHrId: '', starterHrName: '',
          starterConditions: [],
          resubmitMode: 'fresh',
          steps: []
        },
        auditTemplateStepForm: {
          name: '',
          conditions: [],
          actionType: 'sign',
          allowApproverDesignation: false,
          editingIndex: -1
        },
        auditTemplateStepEditorVisible: false,
        auditStarterConditionEditorVisible: false
      });
    },

    editAuditTemplate(e) {
      const id = e.currentTarget.dataset.id;
      const template = this.data.auditFlowTemplates.find(function (t) { return t.id === id; });
      if (!template) return;
      let that = this;
      // Resolve starter conditions
      let starterConds = (template.starterConditions || []).map(function(c) { return that._auditResolveCondition(c); });
      this.setData({
        auditTemplateForm: {
          id: template.id,
          name: template.name,
          description: template.description,
          starterType: template.starterType || 'conditions',
          starterIdentityId: template.starterIdentityId || '',
          starterIdentityName: this._auditIdentityName(template.starterIdentityId),
          starterHrId: template.starterHrId || '',
          starterHrName: this._auditHrName(template.starterHrId),
          starterConditions: starterConds,
          resubmitMode: template.resubmitMode || 'fresh',
          steps: (template.steps || []).map(function(s) {
            return {
              name: s.name || '',
              conditions: (s.conditions || []).map(function(c) { return that._auditResolveCondition(c); }),
              actionType: s.actionType || 'sign',
              allowApproverDesignation: s.allowApproverDesignation === true
            };
          })
        },
        auditTemplateStepEditorVisible: false,
        auditStarterConditionEditorVisible: false
      });
    },

    // Starter type picker
    onStarterTypeChange(e) {
      this.setData({ 'auditTemplateForm.starterType': ['self', 'identity', 'specific_person'][e.detail.value] || 'self' });
    },

    // Resubmit mode picker
    onResubmitModeChange(e) {
      this.setData({ 'auditTemplateForm.resubmitMode': ['fresh', 'from_rejector'][e.detail.value] || 'fresh' });
    },

    // ═══════════════════════════════════════════════
    // Step editor (condition-based)
    // ═══════════════════════════════════════════════

    openAuditTemplateStepEditor(e) {
      const index = e && e.currentTarget ? parseInt(e.currentTarget.dataset.index) : -1;
      if (index >= 0 && this.data.auditTemplateForm.steps[index]) {
        const step = this.data.auditTemplateForm.steps[index];
        this.setData({
          auditTemplateStepForm: {
            name: step.name || '',
            conditions: (step.conditions || []).map(function(c) { return Object.assign({}, c); }),
            actionType: step.actionType || 'sign',
            allowApproverDesignation: step.allowApproverDesignation === true,
            editingIndex: index
          },
          auditTemplateStepEditorVisible: true
        });
      } else {
        this.setData({
          auditTemplateStepForm: {
            name: '',
            conditions: [],
            actionType: 'sign',
            allowApproverDesignation: false,
            editingIndex: -1
          },
          auditTemplateStepEditorVisible: true
        });
      }
    },

    closeAuditTemplateStepEditor() {
      this.setData({ auditTemplateStepEditorVisible: false });
    },

    onStepActionTypeChange(e) {
      this.setData({ 'auditTemplateStepForm.actionType': ['pass', 'sign', 'estamp', 'both'][e.detail.value] || 'sign' });
    },

    onStepApproverDesignationChange(e) {
      this.setData({
        'auditTemplateStepForm.allowApproverDesignation': e.currentTarget.dataset.enabled === true
          || e.currentTarget.dataset.enabled === 'true'
      });
    },

    confirmAuditTemplateStep() {
      const step = this.data.auditTemplateStepForm;
      const stepName = (step.name || '').trim();
      if (!stepName) {
        showShortToast(localeCopy.copy_1376e7cf03);
        return;
      }
      if (!step.conditions || !step.conditions.length) {
        showShortToast(localeCopy.copy_b07e47ba3f);
        return;
      }

      const steps = [...this.data.auditTemplateForm.steps];
      const newStep = {
        name: stepName,
        conditions: step.conditions.map(function(c) { return Object.assign({}, c); }),
        actionType: step.actionType || 'sign',
        allowApproverDesignation: step.allowApproverDesignation === true
      };

      if (step.editingIndex >= 0) {
        steps[step.editingIndex] = newStep;
      } else {
        steps.push(newStep);
      }

      this.setData({
        'auditTemplateForm.steps': steps,
        auditTemplateStepEditorVisible: false
      });
    },

    removeAuditTemplateStep(e) {
      const index = parseInt(e.currentTarget.dataset.index);
      const steps = [...this.data.auditTemplateForm.steps];
      steps.splice(index, 1);
      this.setData({ 'auditTemplateForm.steps': steps });
    },

    // ── Step Condition Editor ──

    openStepConditionEditor(e) {
      const index = e && e.currentTarget ? parseInt(e.currentTarget.dataset.index) : -1;
      if (index >= 0 && this.data.auditTemplateStepForm.conditions[index]) {
        const cond = this.data.auditTemplateStepForm.conditions[index];
        this.setData({
          auditStepConditionForm: {
            conditionType: cond.conditionType || 'identity_scope',
            departmentScope: cond.departmentScope || 'all',
            specificDepartmentId: cond.specificDepartmentId || '',
            specificDepartmentName: cond._deptName || cond.specificDepartmentName || this._auditDeptName(cond.specificDepartmentId),
            workGroupScope: cond.workGroupScope || 'all',
            specificWorkGroupId: cond.specificWorkGroupId || '',
            specificWorkGroupName: cond._wgName || cond.specificWorkGroupName || this._auditWgName(cond.specificWorkGroupId),
            identityScope: cond.identityScope || 'all',
            specificIdentityId: cond.specificIdentityId || '',
            specificIdentityName: cond._identName || cond.specificIdentityName || this._auditIdentityName(cond.specificIdentityId),
            personHrIds: cond.personHrIds || '',
            personHrNames: cond.personHrNames || (cond._personNames ? cond._personNames.join('、') : ''),
            assignmentIds: cond.assignmentIds || '',
            assignmentNames: cond.assignmentNames || (cond._assignmentNames ? cond._assignmentNames.join('、') : '')
          },
          auditStepConditionEditingIndex: index,
          auditStepConditionEditorVisible: true,
          _auditConditionTarget: 'step'
        });
      } else {
        this.setData({
          auditStepConditionForm: {
            conditionType: 'identity_scope',
            departmentScope: 'all', specificDepartmentId: '', specificDepartmentName: '',
            workGroupScope: 'all', specificWorkGroupId: '', specificWorkGroupName: '',
            identityScope: 'all', specificIdentityId: '', specificIdentityName: '',
            personHrIds: '', personHrNames: '', assignmentIds: '', assignmentNames: ''
          },
          auditStepConditionEditingIndex: -1,
          auditStepConditionEditorVisible: true,
          _auditConditionTarget: 'step'
        });
      }
    },

    closeStepConditionEditor() {
      this.setData({ auditStepConditionEditorVisible: false });
    },

    onConditionTypeChange(e) {
      this.setData({ 'auditStepConditionForm.conditionType': ['identity_scope', 'person'][e.detail.value] || 'identity_scope' });
    },

    onConditionScopeChange(e) {
      let field = e.currentTarget.dataset.field;
      let scopes = ['all', 'specific', 'own'];
      let scopeLabels = [localeCopy.copy_31d4595959, localeCopy.copy_2aad29e5cf, localeCopy.copy_4b405169cb];
      let idx = parseInt(e.detail.value);
      this.setData({ ['auditStepConditionForm.' + field]: scopes[idx] || 'all' });
    },

    confirmStepCondition() {
      let cond = this.data.auditStepConditionForm;
      let newCond = {
        conditionType: cond.conditionType
      };

      if (cond.conditionType === 'person') {
        if (!cond.personHrIds || !cond.assignmentIds) {
          showShortToast(localeCopy.copy_e5d78a79f7);
          return;
        }
        newCond.personHrIds = cond.personHrIds;
        newCond.assignmentIds = cond.assignmentIds;
        let assignmentIds = cond.assignmentIds.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        newCond._assignmentNames = assignmentIds.map(function (id) { return this._auditAssignmentName(id); }.bind(this)).filter(Boolean);
        newCond.assignmentNames = newCond._assignmentNames.join('、');
        newCond.personHrNames = newCond.assignmentNames;
        newCond._personNames = newCond._assignmentNames.slice();
      } else {
        // identity_scope — always resolve names from master lists, handling comma-separated IDs
        newCond.departmentScope = cond.departmentScope;
        newCond.specificDepartmentId = cond.departmentScope === 'specific' ? cond.specificDepartmentId : '';
        if (newCond.specificDepartmentId) {
          let deptIds = newCond.specificDepartmentId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          newCond._deptNames = deptIds.map(function(did) { return this._auditDeptName(did); }.bind(this)).filter(Boolean);
          newCond._deptName = newCond._deptNames.join('、');
        } else { newCond._deptNames = []; newCond._deptName = ''; }
        newCond.workGroupScope = cond.workGroupScope;
        newCond.specificWorkGroupId = cond.workGroupScope === 'specific' ? cond.specificWorkGroupId : '';
        if (newCond.specificWorkGroupId) {
          let wgIds = newCond.specificWorkGroupId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          newCond._wgNames = wgIds.map(function(wid) { return this._auditWgName(wid); }.bind(this)).filter(Boolean);
          newCond._wgName = newCond._wgNames.join('、');
        } else { newCond._wgNames = []; newCond._wgName = ''; }
        newCond.identityScope = cond.identityScope;
        newCond.specificIdentityId = cond.identityScope === 'specific' ? cond.specificIdentityId : '';
        if (newCond.specificIdentityId) {
          let identIds = newCond.specificIdentityId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          newCond._identNames = identIds.map(function(iid) { return this._auditIdentityName(iid); }.bind(this)).filter(Boolean);
          newCond._identName = newCond._identNames.join('、');
        } else { newCond._identNames = []; newCond._identName = ''; }
      }
      // Pre-compute display summary
      newCond._summary = this._auditConditionSummary(newCond);

      let conditions = [...this.data.auditTemplateStepForm.conditions];
      if (this.data.auditStepConditionEditingIndex >= 0) {
        conditions[this.data.auditStepConditionEditingIndex] = newCond;
      } else {
        conditions.push(newCond);
      }

      this.setData({
        'auditTemplateStepForm.conditions': conditions,
        auditStepConditionEditorVisible: false
      });
    },

    removeStepCondition(e) {
      let index = parseInt(e.currentTarget.dataset.index);
      let conditions = [...this.data.auditTemplateStepForm.conditions];
      conditions.splice(index, 1);
      this.setData({ 'auditTemplateStepForm.conditions': conditions });
    },

    // ── Build a human-readable summary for a single condition ──
    _auditConditionSummary(c) {
      if (!c) return localeCopy.copy_2dcf2e1cdf;
      if (c.conditionType === 'person') {
        if (c.assignmentIds) {
          let names = c.assignmentIds.split(',').map(function (id) {
            return this._auditAssignmentName(id.trim());
          }.bind(this)).filter(function (n) { return n; });
          return names.length ? names.join('、') : localeCopy.copy_572c4dbb58;
        }
        return localeCopy.copy_b9283ec054;
      }
      // identity_scope — only show what's restricted, skip 'all'
      let parts = [];
      if (c.departmentScope === 'own') {
        parts.push(localeCopy.copy_37ad645951);
      } else if (c.departmentScope === 'specific' && c.specificDepartmentId) {
        parts.push(this._auditDeptName(c.specificDepartmentId) || localeCopy.copy_b3604f443f);
      }
      if (c.workGroupScope === 'own') {
        parts.push(localeCopy.copy_2c67faf1c7);
      } else if (c.workGroupScope === 'specific' && c.specificWorkGroupId) {
        parts.push(this._auditWgName(c.specificWorkGroupId) || localeCopy.copy_258347beac);
      }
      if (c.identityScope === 'own') {
        parts.push(localeCopy.copy_c84650778a);
      } else if (c.identityScope === 'specific' && c.specificIdentityId) {
        parts.push(this._auditIdentityName(c.specificIdentityId) || localeCopy.copy_640342a015);
      }
      if (!parts.length) return localeCopy.copy_532dbd7fc1;
      return parts.join(' · ');
    },

    /**
     * Resolve ALL names in a condition from master lists into _d* fields.
     * Handles comma-separated IDs (multi-select).
     * Returns a new object suitable for WXML bubble rendering.
     */
    _auditResolveCondition(c) {
      let r = Object.assign({}, c);
      if (c.conditionType === 'person') {
        if (c.assignmentIds) {
          let ids = c.assignmentIds.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          r._assignmentNames = ids.map(function (id) { return this._auditAssignmentName(id); }.bind(this)).filter(Boolean);
          r._personNames = r._assignmentNames.slice();
        } else {
          r._assignmentNames = [];
          r._personNames = [];
        }
      } else {
        // Handle comma-separated IDs for specific fields
        if (c.departmentScope === 'specific' && c.specificDepartmentId) {
          let deptIds = c.specificDepartmentId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          r._deptNames = deptIds.map(function(did) { return this._auditDeptName(did); }.bind(this)).filter(Boolean);
          r._deptName = r._deptNames.join('、');
        } else {
          r._deptNames = [];
          r._deptName = '';
        }
        if (c.workGroupScope === 'specific' && c.specificWorkGroupId) {
          let wgIds = c.specificWorkGroupId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          r._wgNames = wgIds.map(function(wid) { return this._auditWgName(wid); }.bind(this)).filter(Boolean);
          r._wgName = r._wgNames.join('、');
        } else {
          r._wgNames = [];
          r._wgName = '';
        }
        if (c.identityScope === 'specific' && c.specificIdentityId) {
          let identIds = c.specificIdentityId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          r._identNames = identIds.map(function(iid) { return this._auditIdentityName(iid); }.bind(this)).filter(Boolean);
          r._identName = r._identNames.join('、');
        } else {
          r._identNames = [];
          r._identName = '';
        }
      }
      return r;
    },

    // ── Open unified multi-picker for step condition fields ──
    openStepConditionPicker(e) {
      let target = e.currentTarget.dataset.target;
      let title = e.currentTarget.dataset.title || localeCopy.copy_c47f370afa;
      let list = [];
      let deptOpts = this._auditBuildDeptOptions();
      let identOpts = this._auditBuildIdentOptions();

      // Determine which list to show
      switch (target) {
        case 'specificDepartmentId':
          list = (this.data.departmentList || []).map(function(d) { return { id: d.id, name: d.name, extra: d.description || '' }; });
          break;
        case 'specificWorkGroupId':
          list = (this.data.workGroupList || []).map(function(w) { return { id: w.id, name: w.name, extra: w.departmentName || '', deptId: w.departmentId || '' }; });
          break;
        case 'specificIdentityId':
          list = (this.data.identityList || []).map(function(i) { return { id: i.id, name: i.name, extra: i.description || '' }; });
          break;
        case 'personHrIds':
          list = this._auditAssignmentOptions();
          break;
      }

      // Build department tabs for work group picker when specific depts are selected
      let deptTabs = [];
      let activeDeptTab = '';
      if (target === 'specificWorkGroupId') {
        let condForm = this.data.auditStepConditionForm || {};
        if (condForm.departmentScope === 'specific' && condForm.specificDepartmentId) {
          let selectedDeptIds = condForm.specificDepartmentId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          let deptMap = {};
          list.forEach(function(wg) {
            if (wg.deptId && selectedDeptIds.indexOf(wg.deptId) >= 0) {
              if (!deptMap[wg.deptId]) deptMap[wg.deptId] = { deptId: wg.deptId, deptName: wg.extra || localeCopy.copy_de00c3e48a, workGroups: [], selectedCount: 0 };
              deptMap[wg.deptId].workGroups.push(wg);
            }
          });
          deptTabs = selectedDeptIds.map(function(did) {
            return deptMap[did] || { deptId: did, deptName: localeCopy.copy_de00c3e48a, workGroups: [], selectedCount: 0 };
          });
          if (deptTabs.length) activeDeptTab = deptTabs[0].deptId;
        }
      }

      // Pre-populate selected IDs
      let selectedIds = {};
      let currentVal = target === 'personHrIds'
        ? (this.data.auditStepConditionForm.assignmentIds || '')
        : (this.data.auditStepConditionForm[target] || '');
      if (currentVal) {
        currentVal.split(',').forEach(function(id) {
          let trimmed = id.trim();
          if (trimmed) selectedIds[String(trimmed)] = true;
        });
      }

      // Initialize per-tab selected counts
      if (deptTabs.length) {
        deptTabs = deptTabs.map(function(tab) {
          let count = tab.workGroups.filter(function(wg) { return selectedIds[String(wg.id)]; }).length;
          return Object.assign({}, tab, { selectedCount: count });
        });
      }

      this.setData({
        auditMultiPickerVisible: true,
        auditMultiPickerTarget: target,
        auditMultiPickerTitle: title,
        auditMultiPickerItems: list,
        auditMultiPickerSelectedIds: selectedIds,
        auditMultiPickerSearchKeyword: '',
        auditMultiPickerFilterDept: localeCopy.copy_31d4595959,
        auditMultiPickerFilterIdent: localeCopy.copy_31d4595959,
        auditMultiPickerDeptOptions: deptOpts,
        auditMultiPickerIdentOptions: identOpts,
        auditMultiPickerFilteredList: [],
        auditMultiPickerSelectedCount: Object.keys(selectedIds).length,
        auditMultiPickerDeptTabs: deptTabs,
        auditMultiPickerActiveDeptTab: activeDeptTab
      });
      this._applyAuditMultiPickerFilters();
    },

    closeAuditMultiPicker() {
      this.setData({ auditMultiPickerVisible: false });
    },

    onAuditMultiPickerDeptTab(e) {
      this.setData({ auditMultiPickerActiveDeptTab: e.currentTarget.dataset.dept }, () => {
        this._applyAuditMultiPickerFilters();
      });
    },

    onAuditMultiPickerSearch(e) {
      this.setData({ auditMultiPickerSearchKeyword: e.detail.value }, () => {
        this._applyAuditMultiPickerFilters();
      });
    },

    onAuditMultiPickerFilterDept(e) {
      let idx = e.detail.value;
      let options = this.data.auditMultiPickerDeptOptions;
      this.setData({ auditMultiPickerFilterDept: options[idx] || localeCopy.copy_31d4595959 }, () => {
        this._applyAuditMultiPickerFilters();
      });
    },

    onAuditMultiPickerFilterIdent(e) {
      let idx = e.detail.value;
      let options = this.data.auditMultiPickerIdentOptions;
      this.setData({ auditMultiPickerFilterIdent: options[idx] || localeCopy.copy_31d4595959 }, () => {
        this._applyAuditMultiPickerFilters();
      });
    },

    _applyAuditMultiPickerFilters() {
      let items = this.data.auditMultiPickerItems;
      let target = this.data.auditMultiPickerTarget;
      let keyword = (this.data.auditMultiPickerSearchKeyword || '').trim().toLowerCase();
      let filterDept = this.data.auditMultiPickerFilterDept;
      let filterIdent = this.data.auditMultiPickerFilterIdent;

      // Department/identity filters only apply to personnel picker
      if (target === 'personHrIds') {
        if (filterDept !== localeCopy.copy_31d4595959) {
          let deptId = this._auditDeptIdByName(filterDept);
          items = items.filter(function(item) { return String(item.deptId || '') === String(deptId || ''); });
        }
        if (filterIdent !== localeCopy.copy_31d4595959) {
          let identId = this._auditIdentIdByName(filterIdent);
          items = items.filter(function(item) { return String(item.identId || '') === String(identId || ''); });
        }
      }

      // Department tab filter for work group picker
      if (target === 'specificWorkGroupId' && this.data.auditMultiPickerDeptTabs.length) {
        let activeTab = this.data.auditMultiPickerActiveDeptTab;
        items = items.filter(function(item) { return String(item.deptId || '') === String(activeTab || ''); });
      }

      if (keyword) {
        items = items.filter(function(item) {
          return [item.name, item.extra].some(function(v) {
            return String(v || '').toLowerCase().indexOf(keyword) !== -1;
          });
        });
      }

      this.setData({ auditMultiPickerFilteredList: items });
    },

    _auditDeptIdByName(name) {
      let found = (this.data.departmentList || []).find(function(d) { return d.name === name; });
      return found ? found.id : '';
    },

    _auditIdentIdByName(name) {
      let found = (this.data.identityList || []).find(function(i) { return i.name === name; });
      return found ? found.id : '';
    },

    onAuditMultiPickerToggle(e) {
      let id = String(e.currentTarget.dataset.id);
      let selected = Object.assign({}, this.data.auditMultiPickerSelectedIds);
      // All pickers support multi-select
      if (selected[id]) {
        delete selected[id];
      } else {
        selected[id] = true;
      }

      // Update per-tab selected counts
      let deptTabs = this.data.auditMultiPickerDeptTabs;
      if (deptTabs.length) {
        deptTabs = deptTabs.map(function(tab) {
          let count = tab.workGroups.filter(function(wg) {
            return selected[String(wg.id)];
          }).length;
          return Object.assign({}, tab, { selectedCount: count });
        });
      }

      this.setData({
        auditMultiPickerSelectedIds: selected,
        auditMultiPickerSelectedCount: Object.keys(selected).length,
        auditMultiPickerDeptTabs: deptTabs
      });
    },

    onAuditMultiPickerSelectAll() {
      let filtered = this.data.auditMultiPickerFilteredList;
      if (!filtered.length) return;
      let selected = Object.assign({}, this.data.auditMultiPickerSelectedIds);
      filtered.forEach(function(item) {
        selected[String(item.id)] = true;
      });

      // Update per-tab selected counts
      let deptTabs = this.data.auditMultiPickerDeptTabs;
      if (deptTabs.length) {
        deptTabs = deptTabs.map(function(tab) {
          let count = tab.workGroups.filter(function(wg) {
            return selected[String(wg.id)];
          }).length;
          return Object.assign({}, tab, { selectedCount: count });
        });
      }

      this.setData({
        auditMultiPickerSelectedIds: selected,
        auditMultiPickerSelectedCount: Object.keys(selected).length,
        auditMultiPickerDeptTabs: deptTabs
      });
    },

    onAuditMultiPickerDeselectAll() {
      // When dept tabs active, only deselect current tab
      let deptTabs = this.data.auditMultiPickerDeptTabs;
      let selected = Object.assign({}, this.data.auditMultiPickerSelectedIds);
      if (deptTabs.length) {
        let activeTab = this.data.auditMultiPickerActiveDeptTab;
        // Remove selections for the active tab only
        deptTabs.forEach(function(tab) {
          if (tab.deptId === activeTab) {
            tab.workGroups.forEach(function(wg) {
              delete selected[String(wg.id)];
            });
          }
        });
        deptTabs = deptTabs.map(function(tab) {
          let count = tab.workGroups.filter(function(wg) {
            return selected[String(wg.id)];
          }).length;
          return Object.assign({}, tab, { selectedCount: count });
        });
      } else {
        selected = {};
      }
      this.setData({
        auditMultiPickerSelectedIds: selected,
        auditMultiPickerSelectedCount: Object.keys(selected).length,
        auditMultiPickerDeptTabs: deptTabs
      });
    },

    confirmAuditMultiPicker() {
      let target = this.data.auditMultiPickerTarget;
      let selectedIds = this.data.auditMultiPickerSelectedIds;
      let ids = Object.keys(selectedIds);
      let items = this.data.auditMultiPickerItems;
      let condTarget = this.data._auditConditionTarget || 'step';
      let formPrefix = condTarget === 'starter' ? 'auditStarterConditionForm' : 'auditStepConditionForm';

      if (!ids.length) {
        showShortToast(localeCopy.copy_4c3b518dca);
        return;
      }

      // Per-department validation for work group picker with department tabs
      if (target === 'specificWorkGroupId' && this.data.auditMultiPickerDeptTabs.length) {
        let tabs = this.data.auditMultiPickerDeptTabs;
        for (let i = 0; i < tabs.length; i++) {
          let tab = tabs[i];
          if (!tab.workGroups.length) continue; // skip empty depts
          let hasSelection = tab.workGroups.some(function(wg) { return selectedIds[String(wg.id)]; });
          if (!hasSelection) {
            showShortToast((tab.deptName || tab.deptId) + localeCopy.copy_bbef5f061c);
            return;
          }
        }
      }

      let selectedItems = ids.map(function(id) {
        let found = items.find(function(item) { return String(item.id) === String(id); });
        return found || null;
      }).filter(Boolean);
      let names = selectedItems.map(function(item) {
        return target === 'personHrIds'
          ? [item.name, item.assignmentLabel].filter(Boolean).join(' · ')
          : item.name;
      }).filter(Boolean).join('、');

      let updateObj = {};
      if (target === 'personHrIds') {
        updateObj[formPrefix + '.personHrIds'] = Array.from(new Set(selectedItems.map(function(item) {
          return String(item.hrId || '');
        }).filter(Boolean))).join(',');
        updateObj[formPrefix + '.personHrNames'] = names;
        updateObj[formPrefix + '.assignmentIds'] = ids.join(',');
        updateObj[formPrefix + '.assignmentNames'] = names;
      } else {
        updateObj[formPrefix + '.' + target] = ids.join(',');
        updateObj[formPrefix + '.' + target.replace('Id', 'Name')] = names;
      }
      this.setData(updateObj);
      this.closeAuditMultiPicker();
    },

    // Clear a field in the condition form (e.g., personHrIds)
    onStepConditionFieldClear(e) {
      let field = e.currentTarget.dataset.field;
      let update = {};
      update['auditStepConditionForm.' + field] = '';
      update['auditStepConditionForm.' + field.replace('Id', 'Name')] = '';
      if (field === 'personHrIds') {
        update['auditStepConditionForm.assignmentIds'] = '';
        update['auditStepConditionForm.assignmentNames'] = '';
      }
      this.setData(update);
    },

    // ── Scope label helpers ──
    _scopeLabel(scope) {
      if (scope === 'all') return localeCopy.copy_31d4595959;
      if (scope === 'own') return localeCopy.copy_4b405169cb;
      if (scope === 'specific') return localeCopy.copy_2aad29e5cf;
      return localeCopy.copy_31d4595959;
    },

    // ═══════════════════════════════════════════════
    // ── Starter Condition Editor ──
    // ═══════════════════════════════════════════════

    openStarterConditionEditor(e) {
      let index = e && e.currentTarget ? parseInt(e.currentTarget.dataset.index) : -1;
      if (index >= 0 && this.data.auditTemplateForm.starterConditions[index]) {
        let c = this.data.auditTemplateForm.starterConditions[index];
        this.setData({
          auditStarterConditionForm: {
            conditionType: c.conditionType || 'identity_scope',
            departmentScope: c.departmentScope || 'all',
            specificDepartmentId: c.specificDepartmentId || '',
            specificDepartmentName: c._deptName || c.specificDepartmentName || this._auditDeptName(c.specificDepartmentId),
            workGroupScope: c.workGroupScope || 'all',
            specificWorkGroupId: c.specificWorkGroupId || '',
            specificWorkGroupName: c._wgName || c.specificWorkGroupName || this._auditWgName(c.specificWorkGroupId),
            identityScope: c.identityScope || 'all',
            specificIdentityId: c.specificIdentityId || '',
            specificIdentityName: c._identName || c.specificIdentityName || this._auditIdentityName(c.specificIdentityId),
            personHrIds: c.personHrIds || '',
            personHrNames: c.personHrNames || (c._personNames ? c._personNames.join('、') : ''),
            assignmentIds: c.assignmentIds || '',
            assignmentNames: c.assignmentNames || (c._assignmentNames ? c._assignmentNames.join('、') : '')
          },
          auditStarterConditionEditingIndex: index,
          auditStarterConditionEditorVisible: true
        });
      } else {
        this.setData({
          auditStarterConditionForm: {
            conditionType: 'identity_scope',
            departmentScope: 'all', specificDepartmentId: '', specificDepartmentName: '',
            workGroupScope: 'all', specificWorkGroupId: '', specificWorkGroupName: '',
            identityScope: 'all', specificIdentityId: '', specificIdentityName: '',
            personHrIds: '', personHrNames: '', assignmentIds: '', assignmentNames: ''
          },
          auditStarterConditionEditingIndex: -1,
          auditStarterConditionEditorVisible: true
        });
      }
      this.setData({ _auditConditionTarget: 'starter' });
    },

    closeStarterConditionEditor() {
      this.setData({ auditStarterConditionEditorVisible: false });
    },

    onStarterConditionTypeChange(e) {
      this.setData({ 'auditStarterConditionForm.conditionType': ['identity_scope', 'person'][e.detail.value] || 'identity_scope' });
    },

    onStarterConditionScopeChange(e) {
      let field = e.currentTarget.dataset.field;
      let scopes = ['all', 'specific']; // starter has no 'own' — starter IS the submitter
      let idx = parseInt(e.detail.value);
      this.setData({ ['auditStarterConditionForm.' + field]: scopes[idx] || 'all' });
    },

    confirmStarterCondition() {
      let cond = this.data.auditStarterConditionForm;
      let newCond = { conditionType: cond.conditionType };

      if (cond.conditionType === 'person') {
        if (!cond.personHrIds || !cond.assignmentIds) { showShortToast(localeCopy.copy_e5d78a79f7); return; }
        newCond.personHrIds = cond.personHrIds;
        newCond.assignmentIds = cond.assignmentIds;
        let assignmentIds = cond.assignmentIds.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
        newCond._assignmentNames = assignmentIds.map(function(id) { return this._auditAssignmentName(id); }.bind(this)).filter(Boolean);
        newCond.assignmentNames = newCond._assignmentNames.join('、');
        newCond.personHrNames = newCond.assignmentNames;
        newCond._personNames = newCond._assignmentNames.slice();
      } else {
        newCond.departmentScope = cond.departmentScope;
        newCond.specificDepartmentId = cond.departmentScope === 'specific' ? cond.specificDepartmentId : '';
        if (newCond.specificDepartmentId) {
          let deptIds = newCond.specificDepartmentId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          newCond._deptNames = deptIds.map(function(did) { return this._auditDeptName(did); }.bind(this)).filter(Boolean);
          newCond._deptName = newCond._deptNames.join('、');
        } else { newCond._deptNames = []; newCond._deptName = ''; }
        newCond.workGroupScope = cond.workGroupScope;
        newCond.specificWorkGroupId = cond.workGroupScope === 'specific' ? cond.specificWorkGroupId : '';
        if (newCond.specificWorkGroupId) {
          let wgIds = newCond.specificWorkGroupId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          newCond._wgNames = wgIds.map(function(wid) { return this._auditWgName(wid); }.bind(this)).filter(Boolean);
          newCond._wgName = newCond._wgNames.join('、');
        } else { newCond._wgNames = []; newCond._wgName = ''; }
        newCond.identityScope = cond.identityScope;
        newCond.specificIdentityId = cond.identityScope === 'specific' ? cond.specificIdentityId : '';
        if (newCond.specificIdentityId) {
          let identIds = newCond.specificIdentityId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          newCond._identNames = identIds.map(function(iid) { return this._auditIdentityName(iid); }.bind(this)).filter(Boolean);
          newCond._identName = newCond._identNames.join('、');
        } else { newCond._identNames = []; newCond._identName = ''; }
      }

      let conditions = [...this.data.auditTemplateForm.starterConditions];
      if (this.data.auditStarterConditionEditingIndex >= 0) {
        conditions[this.data.auditStarterConditionEditingIndex] = newCond;
      } else {
        conditions.push(newCond);
      }
      this.setData({
        'auditTemplateForm.starterConditions': conditions,
        auditStarterConditionEditorVisible: false
      });
    },

    removeStarterCondition(e) {
      let index = parseInt(e.currentTarget.dataset.index);
      let conditions = [...this.data.auditTemplateForm.starterConditions];
      conditions.splice(index, 1);
      this.setData({ 'auditTemplateForm.starterConditions': conditions });
    },

    // Open the unified multi-picker for a starter condition field
    openStarterConditionPicker(e) {
      let target = e.currentTarget.dataset.target;
      let title = e.currentTarget.dataset.title || localeCopy.copy_c47f370afa;
      let list = [];
      let deptOpts = this._auditBuildDeptOptions();
      let identOpts = this._auditBuildIdentOptions();

      switch (target) {
        case 'specificDepartmentId':
          list = (this.data.departmentList || []).map(function(d) { return { id: d.id, name: d.name, extra: d.description || '' }; });
          break;
        case 'specificWorkGroupId':
          list = (this.data.workGroupList || []).map(function(w) { return { id: w.id, name: w.name, extra: w.departmentName || '', deptId: w.departmentId || '' }; });
          break;
        case 'specificIdentityId':
          list = (this.data.identityList || []).map(function(i) { return { id: i.id, name: i.name, extra: i.description || '' }; });
          break;
        case 'personHrIds':
          list = this._auditAssignmentOptions();
          break;
      }

      // Build department tabs for work group picker when specific depts are selected
      let deptTabs = [];
      let activeDeptTab = '';
      if (target === 'specificWorkGroupId') {
        let starterForm = this.data.auditStarterConditionForm || {};
        if (starterForm.departmentScope === 'specific' && starterForm.specificDepartmentId) {
          let selectedDeptIds = starterForm.specificDepartmentId.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          let deptMap = {};
          list.forEach(function(wg) {
            if (wg.deptId && selectedDeptIds.indexOf(wg.deptId) >= 0) {
              if (!deptMap[wg.deptId]) deptMap[wg.deptId] = { deptId: wg.deptId, deptName: wg.extra || localeCopy.copy_de00c3e48a, workGroups: [], selectedCount: 0 };
              deptMap[wg.deptId].workGroups.push(wg);
            }
          });
          deptTabs = selectedDeptIds.map(function(did) {
            return deptMap[did] || { deptId: did, deptName: localeCopy.copy_de00c3e48a, workGroups: [], selectedCount: 0 };
          });
          if (deptTabs.length) activeDeptTab = deptTabs[0].deptId;
        }
      }

      let selectedIds = {};
      let currentVal = target === 'personHrIds'
        ? (this.data.auditStarterConditionForm.assignmentIds || '')
        : (this.data.auditStarterConditionForm[target] || '');
      if (currentVal) {
        currentVal.split(',').forEach(function(id) {
          let trimmed = id.trim();
          if (trimmed) selectedIds[String(trimmed)] = true;
        });
      }

      // Initialize per-tab selected counts
      if (deptTabs.length) {
        deptTabs = deptTabs.map(function(tab) {
          let count = tab.workGroups.filter(function(wg) { return selectedIds[String(wg.id)]; }).length;
          return Object.assign({}, tab, { selectedCount: count });
        });
      }

      this.setData({
        auditMultiPickerVisible: true,
        auditMultiPickerTarget: target,
        auditMultiPickerTitle: title,
        auditMultiPickerItems: list,
        auditMultiPickerSelectedIds: selectedIds,
        auditMultiPickerSearchKeyword: '',
        auditMultiPickerFilterDept: localeCopy.copy_31d4595959,
        auditMultiPickerFilterIdent: localeCopy.copy_31d4595959,
        auditMultiPickerDeptOptions: deptOpts,
        auditMultiPickerIdentOptions: identOpts,
        auditMultiPickerFilteredList: [],
        auditMultiPickerDeptTabs: deptTabs,
        auditMultiPickerActiveDeptTab: activeDeptTab,
        _auditConditionTarget: 'starter'
      });
      this._applyAuditMultiPickerFilters();
    },

    // Clear a field in the starter condition form
    onStarterConditionFieldClear(e) {
      let field = e.currentTarget.dataset.field;
      let update = {};
      update['auditStarterConditionForm.' + field] = '';
      update['auditStarterConditionForm.' + field.replace('Id', 'Name')] = '';
      if (field === 'personHrIds') {
        update['auditStarterConditionForm.assignmentIds'] = '';
        update['auditStarterConditionForm.assignmentNames'] = '';
      }
      this.setData(update);
    },

    // Build a human-readable summary for starter conditions
    _auditStarterSummary() {
      let conds = this.data.auditTemplateForm.starterConditions;
      if (!conds || !conds.length) return localeCopy.copy_44ce43b050;
      return conds.map(function(c) { return this._auditConditionSummary(c); }.bind(this)).join(localeCopy.copy_17bcc41217);
    },

    async saveAuditFlowTemplate() {
      const form = this.data.auditTemplateForm;
      if (!form.name) { showShortToast(localeCopy.copy_cf05c2ba56); return; }
      if (!form.steps.length) { showShortToast(localeCopy.copy_6dc1d42f93); return; }
      // Validate each step has at least one condition
      for (let i = 0; i < form.steps.length; i++) {
        if (!form.steps[i].conditions || !form.steps[i].conditions.length) {
          showShortToast(localeCopy.copy_93c50c01c0 + (i + 1) + localeCopy.copy_287253008b);
          return;
        }
      }

      this.setLoading('saveAuditTemplate', true);
      try {
        let stepsToSend = form.steps.map(function(s) {
          return {
            name: s.name || '',
            conditions: s.conditions.map(function(c) {
              let cond = { conditionType: c.conditionType };
              if (c.conditionType === 'person') {
                cond.personHrIds = c.personHrIds;
                cond.assignmentIds = c.assignmentIds;
              } else {
                cond.departmentScope = c.departmentScope || 'all';
                cond.specificDepartmentId = c.specificDepartmentId || '';
                cond.workGroupScope = c.workGroupScope || 'all';
                cond.specificWorkGroupId = c.specificWorkGroupId || '';
                cond.identityScope = c.identityScope || 'all';
                cond.specificIdentityId = c.specificIdentityId || '';
              }
              return cond;
            }),
            actionType: s.actionType || 'sign',
            allowApproverDesignation: s.allowApproverDesignation === true
          };
        });

        let starterCondsToSend = (form.starterConditions || []).map(function(c) {
          let cond = { conditionType: c.conditionType };
          if (c.conditionType === 'person') {
            cond.personHrIds = c.personHrIds;
            cond.assignmentIds = c.assignmentIds;
          } else {
            cond.departmentScope = c.departmentScope || 'all';
            cond.specificDepartmentId = c.specificDepartmentId || '';
            cond.workGroupScope = c.workGroupScope || 'all';
            cond.specificWorkGroupId = c.specificWorkGroupId || '';
            cond.identityScope = c.identityScope || 'all';
            cond.specificIdentityId = c.specificIdentityId || '';
          }
          return cond;
        });

        const res = await this.callCloud('saveAuditFlowTemplate', {
          id: form.id,
          name: form.name,
          description: form.description,
          starterType: form.starterType,
          starterIdentityId: form.starterIdentityId,
          starterHrId: form.starterHrId,
          starterConditions: starterCondsToSend,
          resubmitMode: form.resubmitMode,
          steps: stepsToSend
        });
        if (res.status === 'success') {
          showShortToast(form.id ? localeCopy.copy_c0182529aa : localeCopy.copy_e06667ae8f);
          this.startCreateAuditTemplate();
          this.loadAuditFlowTemplates();
        } else {
          showShortToast(res.message || localeCopy.copy_215e3c57da);
        }
      } catch (e) {
        showShortToast(getErrorText(e, localeCopy.copy_215e3c57da));
      } finally {
        this.setLoading('saveAuditTemplate', false);
      }
    },

    async deleteAuditFlowTemplate(e) {
      const id = e.currentTarget.dataset.id;
      const that = this;
      wx.showModal({
        title: localeCopy.copy_7f31eec657,
        content: localeCopy.copy_e32406217a,
        success: async function (modalRes) {
          if (!modalRes.confirm) return;
          try {
            const res = await that.callCloud('deleteAuditFlowTemplate', { id: id });
            if (res.status === 'success') {
              showShortToast(localeCopy.copy_efc8493bdc);
              that.loadAuditFlowTemplates();
            } else {
              showShortToast(res.message || localeCopy.copy_076bb5d383);
            }
          } catch (e) {
            showShortToast(getErrorText(e, localeCopy.copy_076bb5d383));
          }
        }
      });
    },

    // Toggle expand/collapse of a template to show step details
    toggleAuditTemplateExpand(e) {
      let id = e.currentTarget.dataset.id;
      let current = this.data.auditExpandedTemplateId;
      this.setData({ auditExpandedTemplateId: current === id ? '' : id });
    },

    // ═══════════════════════════════════════════════════════
    // Stamps Management
    // ═══════════════════════════════════════════════════════

    async loadStamps() {
      const request = orgSession.beginRequest(this, 'auditStamps');
      this.setLoading('auditStamps', true);
      try {
        const res = await this.callCloud('listStamps', {});
        if (!orgSession.isRequestCurrent(this, request)) return;
        if (res.status === 'success') {
          this.setData({ stamps: res.stamps || [] });
        } else {
          console.error('[audit] listStamps failed:', res.message);
        }
      } catch (e) {
        if (!orgSession.isRequestCurrent(this, request) || (e && e.silent)) return;
        console.error('[audit] loadStamps error:', e);
        this.setData({ stamps: [] });
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setLoading('auditStamps', false);
      }
    },

    startCreateStamp() {
      this.setData({ stampForm: { id: '', name: '', imageData: '' } });
    },

    editStamp(e) {
      const id = e.currentTarget.dataset.id;
      const stamp = this.data.stamps.find(function (s) { return s.id === id; });
      if (!stamp) return;
      this.setData({ stampForm: { id: stamp.id, name: stamp.name, imageData: stamp.imageData } });
    },

    onStampFieldInput(e) {
      const field = e.currentTarget.dataset.field;
      this.setData({ ['stampForm.' + field]: e.detail.value });
    },

    chooseStampImage() {
      const that = this;
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: function (res) {
          const tempFilePath = res.tempFilePaths[0];
          wx.getFileSystemManager().readFile({
            filePath: tempFilePath,
            encoding: 'base64',
            success: function (fileRes) {
              const ext = tempFilePath.split('.').pop().toLowerCase();
              const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
              const mime = mimeMap[ext] || 'image/png';
              const base64 = 'data:' + mime + ';base64,' + fileRes.data;
              that.setData({ 'stampForm.imageData': base64 });
            }
          });
        }
      });
    },

    async saveStamp() {
      const form = this.data.stampForm;
      if (!form.name) { showShortToast(localeCopy.copy_76f2662073); return; }
      if (!form.imageData) { showShortToast(localeCopy.copy_9cf20101c9); return; }

      this.setLoading('saveStamp', true);
      try {
        const res = await this.callCloud('saveStamp', {
          id: form.id,
          name: form.name,
          imageData: form.imageData
        });
        if (res.status === 'success') {
          showShortToast(form.id ? localeCopy.copy_161855b67c : localeCopy.copy_8e51c9c0df);
          this.startCreateStamp();
          this.loadStamps();
        } else {
          showShortToast(res.message || localeCopy.copy_215e3c57da);
        }
      } catch (e) {
        showShortToast(getErrorText(e, localeCopy.copy_215e3c57da));
      } finally {
        this.setLoading('saveStamp', false);
      }
    },

    async deleteStamp(e) {
      const id = e.currentTarget.dataset.id;
      const that = this;
      wx.showModal({
        title: localeCopy.copy_7f31eec657,
        content: localeCopy.copy_22a8323f15,
        success: async function (modalRes) {
          if (!modalRes.confirm) return;
          try {
            const res = await that.callCloud('deleteStamp', { id: id });
            if (res.status === 'success') {
              showShortToast(localeCopy.copy_a5d4679cf0);
              that.loadStamps();
            } else {
              showShortToast(res.message || localeCopy.copy_076bb5d383);
            }
          } catch (e) {
            showShortToast(getErrorText(e, localeCopy.copy_076bb5d383));
          }
        }
      });
    },

    openStampAssign(e) {
      const identityId = e.currentTarget.dataset.identityId || '';
      const selectedIds = (this.data.stamps || [])
        .filter(function (s) { return (s.assignedIdentities || []).some(function (a) { return a.identityId === identityId; }); })
        .map(function (s) { return s.id; });

      this.setData({
        stampAssignIdentityId: identityId,
        stampAssignSelectedIds: selectedIds,
        stampAssignVisible: true
      });
    },

    closeStampAssign() {
      this.setData({ stampAssignVisible: false });
    },

    toggleStampAssignSelect(e) {
      const id = e.currentTarget.dataset.id;
      const selected = [...this.data.stampAssignSelectedIds];
      const idx = selected.indexOf(id);
      if (idx >= 0) selected.splice(idx, 1);
      else selected.push(id);
      this.setData({ stampAssignSelectedIds: selected });
    },

    async saveStampAssignments() {
      try {
        const res = await this.callCloud('saveStampAssignments', {
          identityId: this.data.stampAssignIdentityId,
          stampIds: this.data.stampAssignSelectedIds
        });
        if (res.status === 'success') {
          showShortToast(localeCopy.copy_cb20eb18bc);
          this.closeStampAssign();
          this.loadStamps();
        } else {
          showShortToast(res.message || localeCopy.copy_215e3c57da);
        }
      } catch (e) {
        showShortToast(getErrorText(e, localeCopy.copy_215e3c57da));
      }
    },

    // ═══════════════════════════════════════════════════════
    // Audit Submissions (Admin View)
    // ═══════════════════════════════════════════════════════

    async loadAuditSubmissions() {
      const request = orgSession.beginRequest(this, 'auditSubmissions');
      this.setLoading('auditSubmissions', true);
      try {
        const filters = this.data.auditSubmissionFilters;
        const res = await this.callCloud('listAllAuditSubmissions', {
          status: filters.status || '',
          limit: 50,
          offset: 0
        });
        if (!orgSession.isRequestCurrent(this, request)) return;
        if (res.status === 'success') {
          this.setData({ auditSubmissions: (res.submissions || []).map((item) => Object.assign({}, item, {
            createdAtText: formatAuditTime(item.createdAt, item.createdAtReviewStatus)
          })) });
        } else {
          console.error('[audit] listAllAuditSubmissions failed:', res.message);
        }
      } catch (e) {
        if (!orgSession.isRequestCurrent(this, request) || (e && e.silent)) return;
        console.error('[audit] loadAuditSubmissions error:', e);
        this.setData({ auditSubmissions: [] });
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setLoading('auditSubmissions', false);
      }
    },

    onAuditSubmissionStatusFilter(e) {
      const statuses = ['', 'draft', 'pending', 'in_progress', 'rejected', 'approved', 'withdrawn'];
      const idx = parseInt(e.detail.value);
      this.setData({ 'auditSubmissionFilters.status': statuses[idx] || '' });
      this.loadAuditSubmissions();
    },

    async viewAuditProgress(e) {
      const submissionId = e.currentTarget.dataset.id;
      this.setLoading('auditProgress', true);
      try {
        const res = await this.callCloud('getAuditProgress', { submissionId: submissionId });
        if (res.status === 'success') {
          const submissionStatus = res.submission.status;
          const currentStepIndex = res.submission.currentStepIndex || 0;
          const rawSteps = res.steps || [];

          // Build flow timeline from server events + steps
          let serverEvents = res.events || [];
          const flowTimeline = [];

          // 1. Build lifecycle nodes from REAL server events
          let lifecycleEvents = [];
          for (let ei = 0; ei < serverEvents.length; ei++) {
            let evt = serverEvents[ei];
            if (evt.eventType === 'submit' || evt.eventType === 'withdraw' || evt.eventType === 'resubmit') {
              lifecycleEvents.push(evt);
            }
          }

          // 2. Group steps by round
          const rounds = {};
          for (const s of rawSteps) {
            const r = s.round || 1;
            if (!rounds[r]) rounds[r] = [];
            rounds[r].push(s);
          }
          const roundKeys = Object.keys(rounds).sort((a, b) => Number(a) - Number(b));

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

          // Only show submit if there IS a submit event
          if (initialSubmit) {
            flowTimeline.push({
              _key: 'lifecycle_submit',
              type: 'lifecycle', event: 'submit', label: localeCopy.copy_c94eb77b73,
              time: formatAuditTime(initialSubmit.createdAt, initialSubmit.createdAtReviewStatus), iconName: 'file'
            });
          }

          // 4. For each round, show steps with lifecycle events between
          let nextEventIdx = usedEventIdx;

          for (let ri = 0; ri < roundKeys.length; ri++) {
            const round = Number(roundKeys[ri]);
            const roundSteps = rounds[round].sort((a, b) => a.sort_order - b.sort_order);

            if (round > 1) {
              let resubmitEvt = null;
              for (let ei3 = nextEventIdx; ei3 < lifecycleEvents.length; ei3++) {
                if (lifecycleEvents[ei3].eventType === 'resubmit' && lifecycleEvents[ei3].round === round) {
                  resubmitEvt = lifecycleEvents[ei3];
                  nextEventIdx = ei3 + 1;
                  break;
                }
              }
              if (resubmitEvt) {
                flowTimeline.push({
                  _key: 'lifecycle_resubmit_r' + round,
                  type: 'lifecycle', event: 'resubmit', label: localeCopy.copy_aed5de2d69,
                  subLabel: localeCopy.copy_93c50c01c0 + round + localeCopy.copy_14144be09d,
                  time: formatAuditTime(resubmitEvt.createdAt, resubmitEvt.createdAtReviewStatus),
                  iconName: 'edit'
                });
              } else {
                flowTimeline.push({
                  _key: 'lifecycle_resubmit_r' + round,
                  type: 'lifecycle', event: 'resubmit', label: localeCopy.copy_aed5de2d69,
                  subLabel: localeCopy.copy_93c50c01c0 + round + localeCopy.copy_14144be09d, iconName: 'edit'
                });
              }
            }

            let hasProcessedSteps = false;
            let hasFutureSteps = false;

            for (const s of roundSteps) {
              let flowNodeClass, flowDotClass, flowIcon, flowStatusLabel, flowTagClass;

              // Build approver description
              let approverDesc = s.approverDesc || '';
              if (!approverDesc) {
                if (s.approverType === 'specific_person' || s.approverName) {
                  approverDesc = localeCopy.copy_d3028048b3 + (s.approverName || localeCopy.copy_86bbf0d28e) + localeCopy.copy_7abed5378f;
                } else {
                  const identName = s.approverIdentityName || localeCopy.copy_c76fae0e08;
                  const scopeType = s.scopeType || 'all';
                  if (scopeType === 'all' || !scopeType) {
                    approverDesc = localeCopy.copy_9b774f950c + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'same_department') {
                    approverDesc = localeCopy.copy_fc98ff863c + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'same_work_group') {
                    approverDesc = localeCopy.copy_d0348010eb + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'specific_department') {
                    const deptName = s.scopeDepartmentName || localeCopy.copy_b3604f443f;
                    approverDesc = localeCopy.copy_d3028048b3 + deptName + ' ' + identName + localeCopy.copy_7abed5378f;
                  } else if (scopeType === 'specific_work_group') {
                    const deptName = s.scopeDepartmentName || '';
                    const wgName = s.scopeWorkGroupName || '';
                    const location = [deptName, wgName].filter(Boolean).join('·') || localeCopy.copy_258347beac;
                    approverDesc = localeCopy.copy_d3028048b3 + location + ' ' + identName + localeCopy.copy_7abed5378f;
                  } else {
                    approverDesc = localeCopy.copy_d3028048b3 + identName + localeCopy.copy_7abed5378f;
                  }
                }
              }

              const actionMap = { pass: localeCopy.copy_8e2f75159e, sign: localeCopy.copy_49cbf30d6b, estamp: localeCopy.copy_7e6630535d, both: localeCopy.copy_a63d02480e };
              const actionLabel = actionMap[s.actionType] || s.actionType || localeCopy.copy_8e2f75159e;

              if (s.status === 'rejected') {
                flowNodeClass = 'flow-node-rejected'; flowDotClass = 'flow-dot-rejected';
                flowIcon = 'cross'; flowStatusLabel = localeCopy.copy_70d7f7f742; flowTagClass = 'flow-tag-rejected';
              } else if (submissionStatus === 'approved') {
                flowNodeClass = 'flow-node-done'; flowDotClass = 'flow-dot-done';
                flowIcon = 'check'; flowStatusLabel = localeCopy.copy_2d8cba342c; flowTagClass = 'flow-tag-done';
              } else if (submissionStatus === 'pending' || submissionStatus === 'draft') {
                flowNodeClass = 'flow-node-pending'; flowDotClass = 'flow-dot-pending';
                flowIcon = 'number'; flowStatusLabel = localeCopy.copy_03c3f77e01; flowTagClass = 'flow-tag-pending';
              } else if (s.status === 'approved') {
                flowNodeClass = 'flow-node-done'; flowDotClass = 'flow-dot-done';
                flowIcon = 'check'; flowStatusLabel = localeCopy.copy_2d8cba342c; flowTagClass = 'flow-tag-done';
              } else if (s.sort_order === currentStepIndex && s.status === 'pending') {
                flowNodeClass = 'flow-node-active'; flowDotClass = 'flow-dot-active';
                flowIcon = 'number'; flowStatusLabel = localeCopy.copy_532a477356; flowTagClass = 'flow-tag-active';
                hasProcessedSteps = true;
              } else if (s.sort_order < currentStepIndex) {
                flowNodeClass = 'flow-node-done'; flowDotClass = 'flow-dot-done';
                flowIcon = 'check'; flowStatusLabel = localeCopy.copy_2d8cba342c; flowTagClass = 'flow-tag-done';
                hasProcessedSteps = true;
              } else {
                flowNodeClass = 'flow-node-pending'; flowDotClass = 'flow-dot-pending';
                flowIcon = 'number'; flowStatusLabel = localeCopy.copy_9baefe7c49; flowTagClass = 'flow-tag-pending';
                hasFutureSteps = true;
              }

              if (s.status === 'approved' || s.status === 'rejected') {
                hasProcessedSteps = true;
              }

              flowTimeline.push({
                _key: 'step_' + s.id,
                type: 'step', ...s,
                flowNodeClass, flowDotClass, flowIcon, flowStatusLabel, flowTagClass,
                approverDesc, actionLabel,
                processedAtText: s.processed_at
                  ? formatAuditTime(s.processed_at, s.processed_atReviewStatus)
                  : ''
              });
            }

            // Inject separator
            if (hasProcessedSteps && hasFutureSteps) {
              let remainingCount = roundSteps.filter(function(rs) {
                return rs.status === 'pending' && rs.sort_order > currentStepIndex;
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

          // 5. Remaining lifecycle events after last round
          for (let ei4 = nextEventIdx; ei4 < lifecycleEvents.length; ei4++) {
            let lateEvt = lifecycleEvents[ei4];
            if (lateEvt.eventType === 'withdraw') {
              flowTimeline.push({
                _key: 'lifecycle_withdraw_' + lateEvt.id,
                type: 'lifecycle', event: 'withdraw', label: localeCopy.copy_0f438fa581,
                time: formatAuditTime(lateEvt.createdAt, lateEvt.createdAtReviewStatus), iconName: 'chevron-right'
              });
            } else if (lateEvt.eventType === 'resubmit') {
              flowTimeline.push({
                _key: 'lifecycle_resubmit_late_' + lateEvt.id,
                type: 'lifecycle', event: 'resubmit', label: localeCopy.copy_aed5de2d69,
                subLabel: localeCopy.copy_93c50c01c0 + (lateEvt.round || 1) + localeCopy.copy_14144be09d,
                time: formatAuditTime(lateEvt.createdAt, lateEvt.createdAtReviewStatus), iconName: 'edit'
              });
            }
          }

          this.setData({
            auditSubmissionDetail: { ...res, flowTimeline: flowTimeline },
            auditSubmissionDetailVisible: true
          });
        } else {
          showShortToast(res.message || localeCopy.copy_e52119b17e);
        }
      } catch (e) {
        showShortToast(getErrorText(e, localeCopy.copy_e52119b17e));
      } finally {
        this.setLoading('auditProgress', false);
      }
    },

    previewAuditFile(e) {
      const fileId = e.currentTarget.dataset.fileId;
      const fileName = e.currentTarget.dataset.fileName || '';
      if (!fileId) return;
      openAuditFile({ fileId: fileId, fileName: fileName });
    },

    closeAuditSubmissionDetail() {
      this.setData({ auditSubmissionDetailVisible: false });
    },

    // ═══════════════════════════════════════════════════════
    // Verification Management
    // ═══════════════════════════════════════════════════════

    async loadVerificationPermissions() {
      const request = orgSession.beginRequest(this, 'auditVerification');
      this.setLoading('auditVerification', true);
      try {
        const res = await this.callCloud('listVerificationPermissions', {});
        if (!orgSession.isRequestCurrent(this, request)) return;
        if (res.status === 'success') {
          this.setData({ verificationPermissions: res.permissions || [] });
        } else {
          console.error('[audit] listVerificationPermissions failed:', res.message);
        }
      } catch (e) {
        if (!orgSession.isRequestCurrent(this, request) || (e && e.silent)) return;
        console.error('[audit] loadVerificationPermissions error:', e);
        this.setData({ verificationPermissions: [] });
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setLoading('auditVerification', false);
      }
    },

    onVerificationGrantHrInput(e) {
      this.setData({ verificationGrantHrId: e.detail.value });
    },

    async grantVerificationPermission() {
      const hrId = this.data.verificationGrantHrId;
      if (!hrId) { showShortToast(localeCopy.copy_e5d78a79f7); return; }
      try {
        const res = await this.callCloud('saveVerificationPermission', {
          granteeHrId: hrId,
          action: 'grant'
        });
        if (res.status === 'success') {
          showShortToast(localeCopy.copy_31f5d1514b);
          this.setData({ verificationGrantHrId: '', verificationGrantHrName: '' });
          this.loadVerificationPermissions();
        } else {
          showShortToast(res.message || localeCopy.copy_5a0e81ddd2);
        }
      } catch (e) {
        showShortToast(getErrorText(e, localeCopy.copy_5a0e81ddd2));
      }
    },

    async revokeVerificationPermission(e) {
      const hrId = e.currentTarget.dataset.hrId;
      const that = this;
      wx.showModal({
        title: localeCopy.copy_d6c748ac95,
        content: localeCopy.copy_c73a8aa49d,
        success: async function (modalRes) {
          if (!modalRes.confirm) return;
          try {
            const res = await that.callCloud('saveVerificationPermission', {
              granteeHrId: hrId,
              action: 'revoke'
            });
            if (res.status === 'success') {
              showShortToast(localeCopy.copy_c2eabcfd63);
              that.loadVerificationPermissions();
            } else {
              showShortToast(res.message || localeCopy.copy_8351ecc192);
            }
          } catch (e) {
            showShortToast(getErrorText(e, localeCopy.copy_8351ecc192));
          }
        }
      });
    },

    onVerificationInputNumber(e) {
      this.setData({ verificationInputNumber: e.detail.value });
    },

    onVerificationInputId(e) {
      this.setData({ verificationInputId: e.detail.value });
    },

    chooseVerifyFile() {
      const that = this;
      const request = orgSession.beginRequest(this, 'verificationFileRead');
      wx.chooseMessageFile({
        count: 1,
        type: 'all',
        success: function(res) {
          if (!orgSession.isRequestCurrent(that, request)) return;
          const file = res.tempFiles[0];
          if (!file || file.size > 10 * 1024 * 1024) {
            showShortToast(require('../../../../../locales/zh-CN/signingEvidence').fileTooLarge);
            return;
          }
          // 文件字节直接交给服务端验证，不用哈希查询代替上传验真。
          wx.getFileSystemManager().readFile({
            filePath: file.path,
            encoding: 'base64',
            success: function(readRes) {
              if (!orgSession.isRequestCurrent(that, request)) return;
              that.setData({
                verificationFilePath: file.path,
                verificationFileName: file.name,
                verificationFileBase64: readRes.data,
                verificationFileSize: file.size,
                verificationResult: null
              });
            },
            fail: function() {
              if (!orgSession.isRequestCurrent(that, request)) return;
              showShortToast(localeCopy.copy_03d69a9d28);
            }
          });
        }
      });
    },

    onVerificationModeChange(e) {
      const modes = ['number', 'file'];
      this.setData({ verificationMode: modes[e.detail.value] || 'number', verificationResult: null });
    },

    async verifySubmissionChain() {
      const request = orgSession.beginRequest(this, 'auditVerificationChain');
      const params = {};
      const mode = this.data.verificationMode || 'number';

      if (mode === 'number') {
        const number = this.data.verificationInputNumber;
        if (!number) { showShortToast(localeCopy.copy_93eb240494); return; }
        params.submissionNumber = number;
      } else if (mode === 'file') {
        const fileB64 = this.data.verificationFileBase64;
        if (!fileB64) { showShortToast(localeCopy.copy_cbf65b3559); return; }
        params.fileBase64 = fileB64;
      }

      this.setLoading('verifyChain', true);
      try {
        const res = await this.callCloud('verifySignatureChain', params);
        if (!orgSession.isRequestCurrent(this, request)) return;
        if (res.status === 'success') {
          this.setData({ verificationResult: presentVerificationResponse(res) });
        } else {
          showShortToast(res.message || localeCopy.copy_b791913c7a);
        }
      } catch (e) {
        if (!orgSession.isRequestCurrent(this, request)) return;
        showShortToast(getErrorText(e, localeCopy.copy_b791913c7a));
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setLoading('verifyChain', false);
      }
    },

    async selectVerificationMatch(e) {
      const submissionId = e.detail && e.detail.submissionId
        ? e.detail.submissionId
        : e.currentTarget.dataset.submissionId;
      const params = buildMatchVerificationParams(this.data.verificationResult, submissionId, this.data.verificationFileBase64);
      if (!params || params.submissionId === String(this.data.verificationResult && this.data.verificationResult.submissionId || '')) return;
      const request = orgSession.beginRequest(this, 'auditVerificationChain');
      this.setLoading('verifyChain', true);
      try {
        const res = await this.callCloud('verifySignatureChain', params);
        if (!orgSession.isRequestCurrent(this, request)) return;
        if (res.status === 'success') {
          this.setData({ verificationResult: presentVerificationResponse(res) });
        } else {
          showShortToast(res.message || localeCopy.copy_b791913c7a);
        }
      } catch (error) {
        if (!orgSession.isRequestCurrent(this, request)) return;
        showShortToast(getErrorText(error, localeCopy.copy_b791913c7a));
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setLoading('verifyChain', false);
      }
    },

    // ═══════════════════════════════════════════════════════
    // Personnel Picker (single-select, confirm pattern)
    // ═══════════════════════════════════════════════════════

    openAuditPersonnelPicker(e) {
      const target = e.currentTarget.dataset.target;
      const label = e.currentTarget.dataset.label || localeCopy.copy_f262abee38;

      // Pre-populate selectedId from the current target field
      let selectedId = '';
      if (target === 'starterHrId') selectedId = this.data.auditTemplateForm.starterHrId;
      else if (target === 'stepHrId') selectedId = this.data.auditTemplateStepForm.approverHrId;
      else if (target === 'grantHrId') selectedId = this.data.verificationGrantHrId;

      const filterOptions = buildAuditPersonnelFilterOptions(this._hrList || [], localeCopy.copy_31d4595959);
      this.setData({
        auditPersonnelPickerVisible: true,
        auditPersonnelPickerTarget: target,
        auditPersonnelPickerLabel: label,
        auditPersonnelPickerSelectedId: String(selectedId || ''),
        auditPersonnelPickerValue: selectedId
          ? (this._hrList || []).filter(function(item) { return String(item.id) === String(selectedId); })
          : [],
        auditPersonnelPickerOptions: this._hrList || [],
        auditPersonnelSearchKeyword: '',
        auditPersonnelFilterDeptIndex: 0,
        auditPersonnelFilterIdentIndex: 0,
        auditPersonnelFilterWorkGroupIndex: 0,
        auditPersonnelDeptOptions: filterOptions.departments,
        auditPersonnelIdentOptions: filterOptions.identities,
        auditPersonnelWorkGroupOptions: filterOptions.workGroups
      });
      this._applyAuditPersonnelFilters();
    },

    closeAuditPersonnelPicker() {
      this.setData({ auditPersonnelPickerVisible: false });
    },

    confirmSharedAuditPersonnelPicker(e) {
      const keys = e.detail && Array.isArray(e.detail.keys) ? e.detail.keys : [];
      const items = e.detail && Array.isArray(e.detail.items) ? e.detail.items : [];
      const selected = items[0] || {};
      this.setData({ auditPersonnelPickerSelectedId: selected.hrId || selected.id || keys[0] || '' }, () => this.confirmAuditPersonnelPicker());
    },

    onAuditPersonnelSearch(e) {
      this.setData({ auditPersonnelSearchKeyword: e.detail.value });
      this._applyAuditPersonnelFilters();
    },

    onAuditPersonnelFilterDept(e) {
      const idx = Number(e.detail.value) || 0;
      this.setData({ auditPersonnelFilterDeptIndex: idx });
      this._applyAuditPersonnelFilters();
    },

    onAuditPersonnelFilterIdent(e) {
      const idx = Number(e.detail.value) || 0;
      this.setData({ auditPersonnelFilterIdentIndex: idx });
      this._applyAuditPersonnelFilters();
    },

    onAuditPersonnelFilterWorkGroup(e) {
      const idx = Number(e.detail.value) || 0;
      this.setData({ auditPersonnelFilterWorkGroupIndex: idx });
      this._applyAuditPersonnelFilters();
    },

    _applyAuditPersonnelFilters() {
      const department = this.data.auditPersonnelDeptOptions[this.data.auditPersonnelFilterDeptIndex] || {};
      const identity = this.data.auditPersonnelIdentOptions[this.data.auditPersonnelFilterIdentIndex] || {};
      const workGroup = this.data.auditPersonnelWorkGroupOptions[this.data.auditPersonnelFilterWorkGroupIndex] || {};
      this.setData({
        auditPersonnelFilteredList: filterAuditPersonnel(this._hrList || [], {
          departmentKey: department.key || ALL_FILTER_KEY,
          identityKey: identity.key || ALL_FILTER_KEY,
          workGroupKey: workGroup.key || ALL_FILTER_KEY
        }, this.data.auditPersonnelSearchKeyword, AUDIT_PERSONNEL_RENDER_LIMIT)
      });
    },

    onAuditPersonnelToggle(e) {
      let hrId = String(e.currentTarget.dataset.hrId);
      let current = this.data.auditPersonnelPickerSelectedId;
      // Toggle: if already selected, deselect; otherwise select
      this.setData({ auditPersonnelPickerSelectedId: current === hrId ? '' : hrId });
    },

    confirmAuditPersonnelPicker() {
      let selectedId = this.data.auditPersonnelPickerSelectedId;
      if (!selectedId) {
        showShortToast(localeCopy.copy_e0922834ac);
        return;
      }

      let hrList = this._hrList || [];
      let person = hrList.find(function (item) { return String(item.id) === String(selectedId); });
      let hrId = String(selectedId);
      let hrName = person ? person.name : selectedId;

      let target = this.data.auditPersonnelPickerTarget;
      switch (target) {
        case 'starterHrId':
          this.setData({
            'auditTemplateForm.starterHrId': hrId,
            'auditTemplateForm.starterHrName': hrName
          });
          break;
        case 'stepHrId':
          this.setData({
            'auditTemplateStepForm.approverHrId': hrId,
            'auditTemplateStepForm.approverHrName': hrName
          });
          break;
        case 'grantHrId':
          this.setData({
            verificationGrantHrId: hrId,
            verificationGrantHrName: hrName
          });
          break;
      }

      this.setData({ auditPersonnelPickerVisible: false });
    },

    clearAuditPersonnel(e) {
      let target = e.currentTarget.dataset.target;
      switch (target) {
        case 'starterHrId':
          this.setData({
            'auditTemplateForm.starterHrId': '',
            'auditTemplateForm.starterHrName': ''
          });
          break;
        case 'stepHrId':
          this.setData({
            'auditTemplateStepForm.approverHrId': '',
            'auditTemplateStepForm.approverHrName': ''
          });
          break;
        case 'grantHrId':
          this.setData({
            verificationGrantHrId: '',
            verificationGrantHrName: ''
          });
          break;
      }
    },

    // ═══════════════════════════════════════════════════════
    // Identity Picker (single / multi, confirm pattern)
    // ═══════════════════════════════════════════════════════

    openAuditIdentityPicker(e) {
      let target = e.currentTarget.dataset.target;
      let label = e.currentTarget.dataset.label || localeCopy.copy_43c26e4c16;
      let multi = e.currentTarget.dataset.multi === 'true';

      // Pre-populate selected IDs from the current target field
      let selectedIds = {};
      let currentIds = '';
      if (target === 'starterIdentityId') {
        currentIds = this.data.auditTemplateForm.starterIdentityId || '';
      } else if (target === 'stepIdentityId') {
        currentIds = this.data.auditTemplateStepForm.approverIdentityId || '';
      }
      if (currentIds) {
        currentIds.split(',').forEach(function (id) {
          let trimmed = id.trim();
          if (trimmed) selectedIds[trimmed] = true;
        });
      }

      this.setData({
        auditIdentityPickerVisible: true,
        auditIdentityPickerTarget: target,
        auditIdentityPickerLabel: label,
        auditIdentityPickerMulti: multi,
        auditIdentityPickerSelectedIds: selectedIds,
        auditIdentityPickerSelectedCount: Object.keys(selectedIds).length
      });
    },

    closeAuditIdentityPicker() {
      this.setData({
        auditIdentityPickerVisible: false,
        auditIdentityPickerSelectedIds: {},
        auditIdentityPickerSelectedCount: 0
      });
    },

    onAuditIdentityToggle(e) {
      let id = String(e.currentTarget.dataset.id);
      let selectedIds = Object.assign({}, this.data.auditIdentityPickerSelectedIds);

      if (this.data.auditIdentityPickerMulti) {
        if (selectedIds[id]) {
          delete selectedIds[id];
        } else {
          selectedIds[id] = true;
        }
      } else {
        // Single select: clear all, then toggle
        Object.keys(selectedIds).forEach(function (key) { delete selectedIds[key]; });
        if (!selectedIds[id]) {
          selectedIds[id] = true;
        }
      }

      this.setData({
        auditIdentityPickerSelectedIds: selectedIds,
        auditIdentityPickerSelectedCount: Object.keys(selectedIds).length
      });
    },

    confirmAuditIdentityPicker() {
      let selectedIds = this.data.auditIdentityPickerSelectedIds;
      let identityList = this.data.identityList || [];
      let target = this.data.auditIdentityPickerTarget;
      let ids = Object.keys(selectedIds);

      if (!ids.length) {
        showShortToast(localeCopy.copy_ada965777d);
        return;
      }

      let names = ids.map(function (id) {
        let found = identityList.find(function (item) { return String(item.id) === id; });
        return found ? found.name : id;
      }).join('、');

      if (target === 'starterIdentityId') {
        this.setData({
          'auditTemplateForm.starterIdentityId': ids.join(','),
          'auditTemplateForm.starterIdentityName': names
        });
      } else if (target === 'stepIdentityId') {
        this.setData({
          'auditTemplateStepForm.approverIdentityId': ids.join(','),
          'auditTemplateStepForm.approverIdentityName': names
        });
      }

      this.setData({
        auditIdentityPickerVisible: false,
        auditIdentityPickerSelectedIds: {},
        auditIdentityPickerSelectedCount: 0
      });
    },

    clearAuditIdentity(e) {
      let target = e.currentTarget.dataset.target;
      if (target === 'starterIdentityId') {
        this.setData({
          'auditTemplateForm.starterIdentityId': '',
          'auditTemplateForm.starterIdentityName': ''
        });
      } else if (target === 'stepIdentityId') {
        this.setData({
          'auditTemplateStepForm.approverIdentityId': '',
          'auditTemplateStepForm.approverIdentityName': ''
        });
      }
    },

  }
});
