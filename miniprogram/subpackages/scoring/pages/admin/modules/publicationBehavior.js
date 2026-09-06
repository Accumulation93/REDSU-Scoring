const localeCopy = require('../../../../../locales/zh-CN/generated/subpackages/scoring/pages/admin/modules/publicationBehavior');
const { format: localeFormat } = require('../../../../../locales/runtime');
// Behavior: publication tab — auto-extracted from admin.js
// Zero functional changes. All methods preserved exactly.
const utils = require('./adminUtils');
const { saveAndShareFile } = require('../../../../../utils/tableFile');
const orgSession = require('../../../../../utils/orgSession');
const designationCandidateView = require('./designationCandidateView');

function emptyMeritSummaryState() {
  return {
    meritSummaryGroups: [],
    meritSummaryFilteredGroups: [],
    meritSummaryDeptOptions: [localeCopy.copy_31d4595959],
    meritSummaryIdentOptions: [localeCopy.copy_31d4595959],
    meritSummaryWgOptions: [localeCopy.copy_31d4595959],
    meritSummaryFilterDept: localeCopy.copy_31d4595959,
    meritSummaryFilterIdent: localeCopy.copy_31d4595959,
    meritSummaryFilterWg: localeCopy.copy_31d4595959,
    meritSummaryLoading: false,
    meritSummaryLoaded: false,
    meritSummaryLoadFailed: false,
    expandedMeritSummaryClauseId: ''
  };
}

module.exports = Behavior({
  methods: {
    async loadPublicationData(activityId) {
      const request = orgSession.beginRequest(this, 'publicationData');
      const selectedActivityId = String(activityId || '');
      if (!activityId) {
        this.setData({
          publicationForm: { id: '', activityId: '', activityName: '', isPublished: false },
          pubViewRuleList: [],
          pubViewRuleListView: [],
          pubMeritRuleList: [],
          pubMeritRuleListView: [],
          designationList: [],
          publicationAssignmentCandidates: [],
          ...emptyMeritSummaryState()
        });
        return;
      }
      this.setData(emptyMeritSummaryState());
      this.setLoading('publications', true);
      try {
        const result = await this.callCloud('getResultPublication', { activityId });
        if (!orgSession.isRequestCurrent(this, request)
          || String((this.data.publicationForm && this.data.publicationForm.activityId) || '') !== selectedActivityId) return;
        if (result.status === 'success') {
          const pub = result.publication;
          const viewRules = result.viewRules || [];
          const meritRules = result.meritRules || [];
          this.setData({
            publicationForm: pub ? { id: pub.id, activityId: pub.activityId, activityName: this.data.publicationForm.activityName, isPublished: !!pub.isPublished } : { id: '', activityId, activityName: this.data.publicationForm.activityName, isPublished: false },
            pubViewRuleList: viewRules, pubViewRuleListView: viewRules,
            pubMeritRuleList: meritRules, pubMeritRuleListView: meritRules,
            designationList: result.meritListDesignations || [],
            publicationAssignmentCandidates: result.assignmentCandidates || [],
            pubViewRuleSelectedIds: {}, pubViewRuleAllSelected: false,
            pubMeritRuleSelectedIds: {}, pubMeritRuleAllSelected: false
          });
          this.rebuildPubViewRuleFilters(viewRules);
          this.rebuildPubMeritRuleFilters(meritRules);
          if (pub) await this.loadMeritListSummary(activityId);
        } else {
          this.setData({
            pubViewRuleList: [],
            pubViewRuleListView: [],
            pubMeritRuleList: [],
            pubMeritRuleListView: [],
            designationList: [],
            publicationAssignmentCandidates: [],
            ...emptyMeritSummaryState()
          });
        }
      } catch (e) {
        if (orgSession.isRequestCurrent(this, request) && !(e && e.silent)) {
          console.error('loadPublicationData error:', e);
          this.setData({
            pubViewRuleList: [],
            pubViewRuleListView: [],
            pubMeritRuleList: [],
            pubMeritRuleListView: [],
            designationList: [],
            publicationAssignmentCandidates: [],
            ...emptyMeritSummaryState()
          });
        }
      }
      if (orgSession.isRequestCurrent(this, request)) this.setLoading('publications', false);
    },
  
    // ─── Merit list summary (Feature 5) ───,

    async loadMeritListSummary(activityIdOverride) {
      const activityId = activityIdOverride || this.data.publicationForm.activityId;
      if (!activityId) return;
      const request = orgSession.beginRequest(this, 'meritListSummary');
      this.setData({
        meritSummaryLoading: true,
        meritSummaryLoaded: false,
        meritSummaryLoadFailed: false
      });
      try {
        const result = await this.callCloud('getMeritListSummary', { activityId });
        if (!orgSession.isRequestCurrent(this, request) || this.data.publicationForm.activityId !== activityId) return;
        if (result.status === 'success') {
          const groups = result.groups || [];
          // Build filter options
          const deptSet = new Set(), identSet = new Set(), wgSet = new Set();
          groups.forEach(g => {
            g.members.forEach(m => {
              if (m.department) deptSet.add(m.department);
              if (m.identity) identSet.add(m.identity);
              if (m.workGroup) wgSet.add(m.workGroup);
            });
          });
          this.setData({
            meritSummaryGroups: groups,
            meritSummaryFilteredGroups: groups,
            meritSummaryDeptOptions: [localeCopy.copy_31d4595959, ...Array.from(deptSet).sort((a, b) => a.localeCompare(b, 'zh-CN'))],
            meritSummaryIdentOptions: [localeCopy.copy_31d4595959, ...Array.from(identSet).sort((a, b) => a.localeCompare(b, 'zh-CN'))],
            meritSummaryWgOptions: [localeCopy.copy_31d4595959, ...Array.from(wgSet).sort((a, b) => a.localeCompare(b, 'zh-CN'))],
            meritSummaryFilterDept: localeCopy.copy_31d4595959, meritSummaryFilterIdent: localeCopy.copy_31d4595959, meritSummaryFilterWg: localeCopy.copy_31d4595959,
            meritSummaryLoaded: true,
            meritSummaryLoadFailed: false
          });
        } else {
          this.setData({ meritSummaryLoadFailed: true });
        }
      } catch (e) {
        if (orgSession.isRequestCurrent(this, request) && !(e && e.silent)) {
          console.error('loadMeritListSummary error:', e);
          this.setData({ meritSummaryLoadFailed: true });
        }
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setData({ meritSummaryLoading: false });
      }
    },

    applyMeritSummaryFilters() {
      let groups = this.data.meritSummaryGroups || [];
      const deptFilter = this.data.meritSummaryFilterDept;
      const identFilter = this.data.meritSummaryFilterIdent;
      const wgFilter = this.data.meritSummaryFilterWg;
      if (deptFilter !== localeCopy.copy_31d4595959 || identFilter !== localeCopy.copy_31d4595959 || wgFilter !== localeCopy.copy_31d4595959) {
        groups = groups.map(g => ({
          ...g,
          members: g.members.filter(m =>
            (deptFilter === localeCopy.copy_31d4595959 || m.department === deptFilter) &&
            (identFilter === localeCopy.copy_31d4595959 || m.identity === identFilter) &&
            (wgFilter === localeCopy.copy_31d4595959 || m.workGroup === wgFilter)
          )
        })).filter(g => g.members.length > 0);
      }
      this.setData({ meritSummaryFilteredGroups: groups });
    },

    onMeritSummaryFilterChange(e) {
      const field = e.currentTarget.dataset.field;
      const options = this.data[field === 'department' ? 'meritSummaryDeptOptions' : (field === 'identity' ? 'meritSummaryIdentOptions' : 'meritSummaryWgOptions')];
      const value = options[Number(e.detail.value)] || localeCopy.copy_31d4595959;
      if (field === 'department') this.setData({ meritSummaryFilterDept: value });
      else if (field === 'identity') this.setData({ meritSummaryFilterIdent: value });
      else this.setData({ meritSummaryFilterWg: value });
      this.applyMeritSummaryFilters();
    },

    toggleMeritSummaryGroup(e) {
      const clauseId = e.currentTarget.dataset.clauseId || '';
      this.setData({ expandedMeritSummaryClauseId: this.data.expandedMeritSummaryClauseId === clauseId ? '' : clauseId });
    },

    async exportMeritListSummary() {
      const activityId = this.data.publicationForm.activityId;
      if (!activityId) { wx.showToast({ title: localeCopy.copy_c5ed87fa11, icon: 'none' }); return; }
      this.setLoading('exportMeritSummary', true);
      try {
        const result = await this.callCloud('exportMeritListSummary', {
          activityId,
          filterDepartment: this.data.meritSummaryFilterDept === localeCopy.copy_31d4595959 ? '' : this.data.meritSummaryFilterDept,
          filterIdentity: this.data.meritSummaryFilterIdent === localeCopy.copy_31d4595959 ? '' : this.data.meritSummaryFilterIdent,
          filterWorkGroup: this.data.meritSummaryFilterWg === localeCopy.copy_31d4595959 ? '' : this.data.meritSummaryFilterWg
        });
        if (result.status === 'success' && result.fileContent) {
          saveAndShareFile(result.fileContent, result.fileName || localeCopy.copy_08f97574f4, result.extension || 'xlsx');
          wx.showToast({ title: localeFormat(localeCopy.copy_6b2200af27, [result.rowCount || 0]), icon: 'success' });
        } else {
          wx.showToast({ title: result.message || localeCopy.copy_2b61466286, icon: 'none' });
        }
      } catch (e) { wx.showToast({ title: localeCopy.copy_2b61466286, icon: 'none' }); }
      this.setLoading('exportMeritSummary', false);
    },
  
    // ─── Grade band expand/collapse (Feature 4) ───,

    toggleGradeBandExpand(e) {
      const index = parseInt(e.currentTarget.dataset.index, 10);
      this.setData({ expandedGradeBandIndex: this.data.expandedGradeBandIndex === index ? -1 : index });
    },

    getGradeBandColor(gradeName) {
      const map = this.data.gradeBandColorMap || {};
      if (map[gradeName]) return map[gradeName];
      // Fallback: hash the name to pick a color
      const palette = ['#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1'];
      let hash = 0;
      for (let i = 0; i < gradeName.length; i++) hash = ((hash << 5) - hash) + gradeName.charCodeAt(i);
      return palette[Math.abs(hash) % palette.length];
    },
  
    // ─── Publication toggle ───,

    async onPublicationActivityChange(e) {
      const idx = parseInt(e.detail.value, 10);
      const activity = this.data.activityList[idx];
      if (activity) {
        const activityId = activity.id || '';
        // 重置整个 publicationForm（含 id），避免残留上一个活动的旧数据
        this.setData({
          publicationForm: { id: '', activityId, activityName: activity.name || '', isPublished: false },
          pubViewRuleList: [],
          pubViewRuleListView: [],
          pubMeritRuleList: [],
          pubMeritRuleListView: [],
          designationList: [],
          publicationAssignmentCandidates: [],
          ...emptyMeritSummaryState()
        });
        // 切换活动只读取现有配置；新配置必须由管理员明确保存。
        await this.loadPublicationData(activityId);
      }
    },

    onPublicationToggle(e) { this.setData({ 'publicationForm.isPublished': !!e.detail.value }); },

    async savePublication() {
      const form = this.data.publicationForm;
      if (!form.activityId) { wx.showToast({ title: localeCopy.copy_21368b3e76, icon: 'none' }); return; }
      this.setLoading('savePublication', true);
      try {
        const result = await this.callCloud('saveResultPublication', { activityId: form.activityId, isPublished: form.isPublished });
        if (result.status === 'success') {
          wx.showToast({ title: result.message || localeCopy.copy_0aacec2714, icon: 'success' });
          this.setData({ 'publicationForm.id': result.publication.id, 'publicationForm.isPublished': !!result.publication.isPublished });
        } else { wx.showToast({ title: result.message || localeCopy.copy_215e3c57da, icon: 'none' }); }
      } catch (e) { wx.showToast({ title: localeCopy.copy_215e3c57da, icon: 'none' }); }
      this.setLoading('savePublication', false);
    },
  
    // ─── View Rule Filters ───,

    rebuildPubViewRuleFilters(list) {
      const depts = new Set(); const idents = new Set();
      (list || []).forEach(r => { if (r.granteeDepartment) depts.add(r.granteeDepartment); if (r.granteeIdentity) idents.add(r.granteeIdentity); });
      this.setData({
        pubViewRuleFilterOptions: { departments: [localeCopy.copy_31d4595959, ...Array.from(depts).sort((a,b) => a.localeCompare(b, 'zh-CN'))], identities: [localeCopy.copy_31d4595959, ...Array.from(idents).sort((a,b) => a.localeCompare(b, 'zh-CN'))] },
        pubViewRuleListView: list || []
      });
    },

    rebuildPubMeritRuleFilters(list) {
      const depts = new Set(); const idents = new Set();
      (list || []).forEach(r => { if (r.granteeDepartment) depts.add(r.granteeDepartment); if (r.granteeIdentity) idents.add(r.granteeIdentity); });
      this.setData({
        pubMeritRuleFilterOptions: { departments: [localeCopy.copy_31d4595959, ...Array.from(depts).sort((a,b) => a.localeCompare(b, 'zh-CN'))], identities: [localeCopy.copy_31d4595959, ...Array.from(idents).sort((a,b) => a.localeCompare(b, 'zh-CN'))] },
        pubMeritRuleListView: list || []
      });
    },

    onPubViewRuleFilterChange(e) {
      const field = e.currentTarget.dataset.field;
      const optionKey = field === 'identity' ? 'identities' : 'departments';
      const options = (this.data.pubViewRuleFilterOptions || {})[optionKey] || [localeCopy.copy_31d4595959];
      const value = options[Number(e.detail.value)] || localeCopy.copy_31d4595959;
      const next = { ...this.data.pubViewRuleFilters, [field]: value };
      this.setData({ pubViewRuleFilters: next });
      let list = this.data.pubViewRuleList || [];
      if (next.department && next.department !== localeCopy.copy_31d4595959) list = list.filter(r => r.granteeDepartment === next.department);
      if (next.identity && next.identity !== localeCopy.copy_31d4595959) list = list.filter(r => r.granteeIdentity === next.identity);
      this.setData({ pubViewRuleListView: list, pubViewRuleSelectedIds: {}, pubViewRuleAllSelected: false });
    },

    onPubMeritRuleFilterChange(e) {
      const field = e.currentTarget.dataset.field;
      const optionKey = field === 'identity' ? 'identities' : 'departments';
      const options = (this.data.pubMeritRuleFilterOptions || {})[optionKey] || [localeCopy.copy_31d4595959];
      const value = options[Number(e.detail.value)] || localeCopy.copy_31d4595959;
      const next = { ...this.data.pubMeritRuleFilters, [field]: value };
      this.setData({ pubMeritRuleFilters: next });
      let list = this.data.pubMeritRuleList || [];
      if (next.department && next.department !== localeCopy.copy_31d4595959) list = list.filter(r => r.granteeDepartment === next.department);
      if (next.identity && next.identity !== localeCopy.copy_31d4595959) list = list.filter(r => r.granteeIdentity === next.identity);
      this.setData({ pubMeritRuleListView: list, pubMeritRuleSelectedIds: {}, pubMeritRuleAllSelected: false });
    },
  
    // ─── View Rule Category CRUD ───,

    startNewPubViewRule() {
      this.setData({ pubViewRuleForm: { id: '', publicationId: this.data.publicationForm.id || '', granteeDepartmentId: '', granteeDepartment: '', granteeIdentityId: '', granteeIdentity: '', isClauseEditorVisible: false, clauseEditingIndex: -1, clauseScopeType: 'own_results', clauseScopeLabel: localeCopy.copy_9a4a6e8793, clauseTargetIdentityId: '', clauseTargetIdentity: '', clauseDisplayMode: 'score', clauseGradeBands: [], clauses: [] } });
    },

    editPubViewRule(e) {
      const id = e.currentTarget.dataset.id;
      const rule = this.data.pubViewRuleList.find(r => r.id === id);
      if (!rule) return;
      this.setData({ pubViewRuleForm: { id: rule.id, publicationId: rule.publicationId, granteeDepartmentId: rule.granteeDepartmentId, granteeDepartment: rule.granteeDepartment, granteeIdentityId: rule.granteeIdentityId, granteeIdentity: rule.granteeIdentity, isClauseEditorVisible: false, clauseEditingIndex: -1, clauseScopeType: 'own_results', clauseScopeLabel: localeCopy.copy_9a4a6e8793, clauseTargetIdentityId: '', clauseTargetIdentity: '', clauseDisplayMode: 'score', clauseGradeBands: [], clauses: (rule.clauses || []).map(c => ({ scopeType: c.scopeType, scopeLabel: c.scopeLabel || '', targetIdentityId: c.targetIdentityId || '', targetIdentity: c.targetIdentity || '', displayMode: c.displayMode || 'score', gradeBands: (c.gradeBands || []).map(gb => ({ minScore: gb.minScore, maxScore: gb.maxScore, gradeName: gb.gradeName })) })) } });
    },

    async savePubViewRule() {
      const f = this.data.pubViewRuleForm;
      if (!f.granteeDepartmentId || !f.granteeIdentityId) { wx.showToast({ title: localeCopy.copy_6168a520f1, icon: 'none' }); return; }
      if (!f.publicationId) { wx.showToast({ title: localeCopy.copy_0dff72de43, icon: 'none' }); return; }
      this.setLoading('savePubViewRule', true);
      try {
        const result = await this.callCloud('savePubViewRule', { id: f.id, publicationId: f.publicationId, granteeDepartmentId: f.granteeDepartmentId, granteeIdentityId: f.granteeIdentityId, clauses: f.clauses.map(c => ({ scopeType: c.scopeType, targetIdentityId: c.targetIdentityId, displayMode: c.displayMode || 'score', gradeBands: c.displayMode === 'grade' ? (c.gradeBands || []) : [] })) });
        if (result.status === 'success') { wx.showToast({ title: localeCopy.copy_0aacec2714, icon: 'success' }); this.startNewPubViewRule(); this.loadPublicationData(this.data.publicationForm.activityId); }
        else { wx.showToast({ title: result.message || localeCopy.copy_215e3c57da, icon: 'none' }); }
      } catch (e) { wx.showToast({ title: localeCopy.copy_215e3c57da, icon: 'none' }); }
      this.setLoading('savePubViewRule', false);
    },

    async deletePubViewRule(e) {
      const ruleId = e.currentTarget.dataset.id;
      if (!ruleId) return;
      const that = this;
      wx.showModal({ title: localeCopy.copy_7f31eec657, content: localeCopy.copy_1c746ef3fb, success: async (res) => { if (!res.confirm) return; try { const r = await that.callCloud('deletePubViewRule', { ruleId }); if (r.status === 'success') { wx.showToast({ title: localeCopy.copy_5398fec054, icon: 'success' }); that.loadPublicationData(that.data.publicationForm.activityId); } else { wx.showToast({ title: r.message || localeCopy.copy_076bb5d383, icon: 'none' }); } } catch (e) { wx.showToast({ title: localeCopy.copy_076bb5d383, icon: 'none' }); } } });
    },
  
    // ─── View Rule Clause Editor ───,

    openPubViewClauseEditor() { this.setData({ 'pubViewRuleForm.isClauseEditorVisible': true, 'pubViewRuleForm.clauseEditingIndex': -1, 'pubViewRuleForm.clauseScopeType': 'own_results', 'pubViewRuleForm.clauseScopeLabel': localeCopy.copy_9a4a6e8793, 'pubViewRuleForm.clauseTargetIdentityId': '', 'pubViewRuleForm.clauseTargetIdentity': '', 'pubViewRuleForm.clauseDisplayMode': 'score', 'pubViewRuleForm.clauseGradeBands': [] }); },

    cancelPubViewClauseEdit() { this.setData({ 'pubViewRuleForm.isClauseEditorVisible': false, 'pubViewRuleForm.clauseEditingIndex': -1 }); },

    onPubViewClauseScopeChange(e) { const scope = this.data.viewScopeOptions[parseInt(e.detail.value, 10)]; if (scope) this.setData({ 'pubViewRuleForm.clauseScopeType': scope.value, 'pubViewRuleForm.clauseScopeLabel': scope.label }); },

    onPubViewClauseTargetIdentChange(e) { const ident = this.data.identityList[parseInt(e.detail.value, 10)]; if (ident) this.setData({ 'pubViewRuleForm.clauseTargetIdentityId': ident.id, 'pubViewRuleForm.clauseTargetIdentity': ident.name }); },
  
    // ─── Per-clause display mode & grade band handlers ───,

    onPubViewClauseDisplayModeChange(e) {
      const mode = this.data.displayModeOptions[parseInt(e.detail.value, 10)];
      if (mode) this.setData({ 'pubViewRuleForm.clauseDisplayMode': mode.value });
    },

    onClauseGradeBandInput(e) {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      const field = e.currentTarget.dataset.field;
      // Keep raw string — don't parseFloat (breaks "01"→"1") or default to 0 (breaks clearing)
      const value = e.detail.value;
      const bands = [...this.data.pubViewRuleForm.clauseGradeBands];
      if (bands[idx]) {
        bands[idx] = { ...bands[idx], [field]: value };
        this.setData({ 'pubViewRuleForm.clauseGradeBands': bands });
      }
    },

    addClauseGradeBand() {
      const bands = [...this.data.pubViewRuleForm.clauseGradeBands];
      bands.push({ minScore: 0, maxScore: 100, gradeName: '' });
      this.setData({ 'pubViewRuleForm.clauseGradeBands': bands });
    },

    removeClauseGradeBand(e) {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      const bands = [...this.data.pubViewRuleForm.clauseGradeBands];
      bands.splice(idx, 1);
      this.setData({ 'pubViewRuleForm.clauseGradeBands': bands });
    },

    generateClauseDefaultGradeBands() {
      this.setData({ 'pubViewRuleForm.clauseGradeBands': [
        { minScore: 0, maxScore: 59.99, gradeName: localeCopy.copy_c5b6490a3f },
        { minScore: 60, maxScore: 69.99, gradeName: localeCopy.copy_6de197a041 },
        { minScore: 70, maxScore: 79.99, gradeName: localeCopy.copy_644ca4567e },
        { minScore: 80, maxScore: 89.99, gradeName: localeCopy.copy_4f5ffea945 },
        { minScore: 90, maxScore: 100, gradeName: localeCopy.copy_56cbab8f45 }
      ] });
    },

    addPubViewClause() {
      const f = this.data.pubViewRuleForm;
      const clause = { scopeType: f.clauseScopeType, scopeLabel: f.clauseScopeLabel, targetIdentityId: f.clauseTargetIdentityId, targetIdentity: f.clauseTargetIdentity, displayMode: f.clauseDisplayMode || 'score', gradeBands: f.clauseDisplayMode === 'grade' ? (f.clauseGradeBands || []).map(gb => ({ ...gb })) : [] };
      const clauses = [...f.clauses];
      if (f.clauseEditingIndex >= 0) { clauses[f.clauseEditingIndex] = clause; } else { clauses.push(clause); }
      this.setData({ 'pubViewRuleForm.clauses': clauses, 'pubViewRuleForm.isClauseEditorVisible': false, 'pubViewRuleForm.clauseEditingIndex': -1 });
    },

    editPubViewClause(e) {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      const c = this.data.pubViewRuleForm.clauses[idx];
      if (!c) return;
      this.setData({ 'pubViewRuleForm.isClauseEditorVisible': true, 'pubViewRuleForm.clauseEditingIndex': idx, 'pubViewRuleForm.clauseScopeType': c.scopeType, 'pubViewRuleForm.clauseScopeLabel': c.scopeLabel || '', 'pubViewRuleForm.clauseTargetIdentityId': c.targetIdentityId || '', 'pubViewRuleForm.clauseTargetIdentity': c.targetIdentity || '', 'pubViewRuleForm.clauseDisplayMode': c.displayMode || 'score', 'pubViewRuleForm.clauseGradeBands': (c.gradeBands || []).map(gb => ({ minScore: gb.minScore, maxScore: gb.maxScore, gradeName: gb.gradeName })) });
    },

    removePubViewClause(e) { const idx = parseInt(e.currentTarget.dataset.index, 10); const clauses = [...this.data.pubViewRuleForm.clauses]; clauses.splice(idx, 1); this.setData({ 'pubViewRuleForm.clauses': clauses }); },

    onPubViewRuleDeptChange(e) { const dept = this.data.departmentList[parseInt(e.detail.value, 10)]; if (dept) this.setData({ 'pubViewRuleForm.granteeDepartmentId': dept.id, 'pubViewRuleForm.granteeDepartment': dept.name }); },

    onPubViewRuleIdentChange(e) { const ident = this.data.identityList[parseInt(e.detail.value, 10)]; if (ident) this.setData({ 'pubViewRuleForm.granteeIdentityId': ident.id, 'pubViewRuleForm.granteeIdentity': ident.name }); },
  
    // ─── View Rule Category List batch ops ───
    togglePubViewRuleSelection(e) { const id = e.currentTarget.dataset.id; const map = { ...this.data.pubViewRuleSelectedIds }; map[id] = !map[id]; const allSel = this.data.pubViewRuleListView.every(r => map[r.id]); this.setData({ pubViewRuleSelectedIds: map, pubViewRuleAllSelected: allSel }); },
    toggleSelectAllPubViewRules() { const allSel = !this.data.pubViewRuleAllSelected; const map = {}; if (allSel) this.data.pubViewRuleListView.forEach(r => { map[r.id] = true; }); this.setData({ pubViewRuleSelectedIds: map, pubViewRuleAllSelected: allSel }); },
    reverseSelectPubViewRules() { const map = {}; this.data.pubViewRuleListView.forEach(r => { map[r.id] = !this.data.pubViewRuleSelectedIds[r.id]; }); this.setData({ pubViewRuleSelectedIds: map, pubViewRuleAllSelected: this.data.pubViewRuleListView.every(r => map[r.id]) }); },

    async batchDeletePubViewRules() {
      const ids = Object.keys(this.data.pubViewRuleSelectedIds).filter(id => this.data.pubViewRuleSelectedIds[id]);
      if (!ids.length) { wx.showToast({ title: localeCopy.copy_fe25ffc934, icon: 'none' }); return; }
      const that = this;
      wx.showModal({ title: localeCopy.copy_1338b7f36a, content: localeFormat(localeCopy.copy_80406a7947, [ids.length]), success: async (res) => {
        if (!res.confirm) return;
        try {
          const result = await that.callCloud('batchDeletePubViewRules', { ruleIds: ids });
          if (result.status === 'success') {
            wx.showToast({ title: localeFormat(localeCopy.copy_813300cf46, [result.count || ids.length]), icon: 'success' });
          } else {
            wx.showToast({ title: result.message || localeCopy.copy_076bb5d383, icon: 'none' });
          }
        } catch (error) {
          wx.showToast({ title: localeCopy.copy_076bb5d383, icon: 'none' });
        }
        await that.loadPublicationData(that.data.publicationForm.activityId);
      } });
    },
  
    // ─── Merit Rule Category CRUD ───,

    startNewPubMeritRule() {
      this.setData({ pubMeritRuleForm: { id: '', publicationId: this.data.publicationForm.id || '', granteeDepartmentId: '', granteeDepartment: '', granteeIdentityId: '', granteeIdentity: '', isClauseEditorVisible: false, clauseEditingIndex: -1, clauseScopeType: 'all_people', clauseScopeLabel: localeCopy.copy_9a2854d17d, clauseTargetIdentityId: '', clauseTargetIdentity: '', clauseQuotaLimit: 0, clauseRequireExactQuota: false, clauses: [] } });
    },

    editPubMeritRule(e) {
      const id = e.currentTarget.dataset.id;
      const rule = this.data.pubMeritRuleList.find(r => r.id === id);
      if (!rule) return;
      this.setData({ pubMeritRuleForm: { id: rule.id, publicationId: rule.publicationId, granteeDepartmentId: rule.granteeDepartmentId, granteeDepartment: rule.granteeDepartment, granteeIdentityId: rule.granteeIdentityId, granteeIdentity: rule.granteeIdentity, isClauseEditorVisible: false, clauseEditingIndex: -1, clauseScopeType: 'all_people', clauseScopeLabel: localeCopy.copy_9a2854d17d, clauseTargetIdentityId: '', clauseTargetIdentity: '', clauseQuotaLimit: 0, clauseRequireExactQuota: false, clauses: (rule.clauses || []).map(c => ({ ...c })) } });
    },

    async savePubMeritRule() {
      const f = this.data.pubMeritRuleForm;
      if (!f.granteeDepartmentId || !f.granteeIdentityId) { wx.showToast({ title: localeCopy.copy_6168a520f1, icon: 'none' }); return; }
      if (!f.publicationId) { wx.showToast({ title: localeCopy.copy_0dff72de43, icon: 'none' }); return; }
      this.setLoading('savePubMeritRule', true);
      try {
        const result = await this.callCloud('savePubMeritRule', { id: f.id, publicationId: f.publicationId, granteeDepartmentId: f.granteeDepartmentId, granteeIdentityId: f.granteeIdentityId, clauses: f.clauses.map(c => ({ scopeType: c.scopeType, targetIdentityId: c.targetIdentityId, quotaLimit: c.quotaLimit, requireExactQuota: c.requireExactQuota })) });
        if (result.status === 'success') { wx.showToast({ title: localeCopy.copy_0aacec2714, icon: 'success' }); this.startNewPubMeritRule(); this.loadPublicationData(this.data.publicationForm.activityId); }
        else { wx.showToast({ title: result.message || localeCopy.copy_215e3c57da, icon: 'none' }); }
      } catch (e) { wx.showToast({ title: localeCopy.copy_215e3c57da, icon: 'none' }); }
      this.setLoading('savePubMeritRule', false);
    },

    async deletePubMeritRule(e) {
      const ruleId = e.currentTarget.dataset.id;
      if (!ruleId) return;
      const that = this;
      wx.showModal({ title: localeCopy.copy_7f31eec657, content: localeCopy.copy_323c50bf75, success: async (res) => { if (!res.confirm) return; try { const r = await that.callCloud('deletePubMeritRule', { ruleId }); if (r.status === 'success') { wx.showToast({ title: localeCopy.copy_5398fec054, icon: 'success' }); that.loadPublicationData(that.data.publicationForm.activityId); } else { wx.showToast({ title: r.message || localeCopy.copy_076bb5d383, icon: 'none' }); } } catch (e) { wx.showToast({ title: localeCopy.copy_076bb5d383, icon: 'none' }); } } });
    },
  
    // ─── Merit Rule Clause Editor ───,

    openPubMeritClauseEditor() { this.setData({ 'pubMeritRuleForm.isClauseEditorVisible': true, 'pubMeritRuleForm.clauseEditingIndex': -1, 'pubMeritRuleForm.clauseScopeType': 'all_people', 'pubMeritRuleForm.clauseScopeLabel': localeCopy.copy_9a2854d17d, 'pubMeritRuleForm.clauseTargetIdentityId': '', 'pubMeritRuleForm.clauseTargetIdentity': '', 'pubMeritRuleForm.clauseQuotaLimit': 0, 'pubMeritRuleForm.clauseRequireExactQuota': false }); },

    cancelPubMeritClauseEdit() { this.setData({ 'pubMeritRuleForm.isClauseEditorVisible': false, 'pubMeritRuleForm.clauseEditingIndex': -1 }); },

    onPubMeritClauseScopeChange(e) { const scope = this.data.viewScopeOptions[parseInt(e.detail.value, 10)]; if (scope) this.setData({ 'pubMeritRuleForm.clauseScopeType': scope.value, 'pubMeritRuleForm.clauseScopeLabel': scope.label }); },

    onPubMeritClauseTargetIdentChange(e) { const ident = this.data.identityList[parseInt(e.detail.value, 10)]; if (ident) this.setData({ 'pubMeritRuleForm.clauseTargetIdentityId': ident.id, 'pubMeritRuleForm.clauseTargetIdentity': ident.name }); },

    onPubMeritClauseQuotaInput(e) { this.setData({ 'pubMeritRuleForm.clauseQuotaLimit': Math.max(0, parseInt(e.detail.value, 10) || 0) }); },

    onPubMeritClauseExactToggle(e) { this.setData({ 'pubMeritRuleForm.clauseRequireExactQuota': !!e.detail.value }); },

    addPubMeritClause() {
      const f = this.data.pubMeritRuleForm;
      if (!f.clauseTargetIdentityId) { wx.showToast({ title: localeCopy.copy_5ece2c09c8, icon: 'none' }); return; }
      const clause = { scopeType: f.clauseScopeType, scopeLabel: f.clauseScopeLabel, targetIdentityId: f.clauseTargetIdentityId, targetIdentity: f.clauseTargetIdentity, quotaLimit: f.clauseQuotaLimit, requireExactQuota: f.clauseRequireExactQuota };
      const clauses = [...f.clauses];
      if (f.clauseEditingIndex >= 0) { clauses[f.clauseEditingIndex] = clause; } else { clauses.push(clause); }
      this.setData({ 'pubMeritRuleForm.clauses': clauses, 'pubMeritRuleForm.isClauseEditorVisible': false, 'pubMeritRuleForm.clauseEditingIndex': -1 });
    },

    editPubMeritClause(e) { const idx = parseInt(e.currentTarget.dataset.index, 10); const c = this.data.pubMeritRuleForm.clauses[idx]; if (!c) return; this.setData({ 'pubMeritRuleForm.isClauseEditorVisible': true, 'pubMeritRuleForm.clauseEditingIndex': idx, 'pubMeritRuleForm.clauseScopeType': c.scopeType, 'pubMeritRuleForm.clauseScopeLabel': c.scopeLabel, 'pubMeritRuleForm.clauseTargetIdentityId': c.targetIdentityId, 'pubMeritRuleForm.clauseTargetIdentity': c.targetIdentity, 'pubMeritRuleForm.clauseQuotaLimit': c.quotaLimit || 0, 'pubMeritRuleForm.clauseRequireExactQuota': c.requireExactQuota || false }); },

    removePubMeritClause(e) { const idx = parseInt(e.currentTarget.dataset.index, 10); const clauses = [...this.data.pubMeritRuleForm.clauses]; clauses.splice(idx, 1); this.setData({ 'pubMeritRuleForm.clauses': clauses }); },

    onPubMeritRuleDeptChange(e) { const dept = this.data.departmentList[parseInt(e.detail.value, 10)]; if (dept) this.setData({ 'pubMeritRuleForm.granteeDepartmentId': dept.id, 'pubMeritRuleForm.granteeDepartment': dept.name }); },

    onPubMeritRuleIdentChange(e) { const ident = this.data.identityList[parseInt(e.detail.value, 10)]; if (ident) this.setData({ 'pubMeritRuleForm.granteeIdentityId': ident.id, 'pubMeritRuleForm.granteeIdentity': ident.name }); },
  
    // ─── Merit Rule Category List batch ops ───
    togglePubMeritRuleSelection(e) { const id = e.currentTarget.dataset.id; const map = { ...this.data.pubMeritRuleSelectedIds }; map[id] = !map[id]; const allSel = this.data.pubMeritRuleListView.every(r => map[r.id]); this.setData({ pubMeritRuleSelectedIds: map, pubMeritRuleAllSelected: allSel }); },
    toggleSelectAllPubMeritRules() { const allSel = !this.data.pubMeritRuleAllSelected; const map = {}; if (allSel) this.data.pubMeritRuleListView.forEach(r => { map[r.id] = true; }); this.setData({ pubMeritRuleSelectedIds: map, pubMeritRuleAllSelected: allSel }); },
    reverseSelectPubMeritRules() { const map = {}; this.data.pubMeritRuleListView.forEach(r => { map[r.id] = !this.data.pubMeritRuleSelectedIds[r.id]; }); this.setData({ pubMeritRuleSelectedIds: map, pubMeritRuleAllSelected: this.data.pubMeritRuleListView.every(r => map[r.id]) }); },

    async batchDeletePubMeritRules() {
      const ids = Object.keys(this.data.pubMeritRuleSelectedIds).filter(id => this.data.pubMeritRuleSelectedIds[id]);
      if (!ids.length) { wx.showToast({ title: localeCopy.copy_fe25ffc934, icon: 'none' }); return; }
      const that = this;
      wx.showModal({ title: localeCopy.copy_1338b7f36a, content: localeFormat(localeCopy.copy_80406a7947, [ids.length]), success: async (res) => {
        if (!res.confirm) return;
        try {
          const result = await that.callCloud('batchDeletePubMeritRules', { ruleIds: ids });
          if (result.status === 'success') {
            wx.showToast({ title: localeFormat(localeCopy.copy_813300cf46, [result.count || ids.length]), icon: 'success' });
          } else {
            wx.showToast({ title: result.message || localeCopy.copy_076bb5d383, icon: 'none' });
          }
        } catch (error) {
          wx.showToast({ title: localeCopy.copy_076bb5d383, icon: 'none' });
        }
        await that.loadPublicationData(that.data.publicationForm.activityId);
      } });
    },
  
    // ─── Generate default categories ───,

    async generatePubViewRules() {
      const pubId = this.data.publicationForm.id;
      if (!pubId) { wx.showToast({ title: localeCopy.copy_477934f658, icon: 'none' }); return; }
      this.setLoading('generatePubViewRules', true);
      try {
        const result = await this.callCloud('generatePubViewRules', { publicationId: pubId });
        if (result.status === 'success') {
          const parts = [];
          if (result.createdCount > 0) parts.push(localeFormat(localeCopy.copy_d50cdab568, [result.createdCount]));
          if (result.skippedCount > 0) parts.push(localeFormat(localeCopy.copy_01ed9fb4f4, [result.skippedCount]));
          if (result.backfilledCount > 0) parts.push(localeFormat(localeCopy.copy_1f152441c7, [result.backfilledCount]));
          const msg = parts.length > 0 ? parts.join('，') : localeCopy.copy_2b3035d391;
          wx.showToast({ title: msg, icon: 'success' });
          this.loadPublicationData(this.data.publicationForm.activityId);
        } else {
          wx.showToast({ title: result.message || localeCopy.copy_9662ceba48, icon: 'none' });
        }
      } catch (e) { wx.showToast({ title: localeCopy.copy_9662ceba48, icon: 'none' }); }
      this.setLoading('generatePubViewRules', false);
    },

    async generatePubMeritRules() {
      const pubId = this.data.publicationForm.id;
      if (!pubId) { wx.showToast({ title: localeCopy.copy_477934f658, icon: 'none' }); return; }
      this.setLoading('generatePubMeritRules', true);
      try {
        const result = await this.callCloud('generatePubMeritRules', { publicationId: pubId });
        if (result.status === 'success') {
          const parts = [];
          if (result.createdCount > 0) parts.push(localeFormat(localeCopy.copy_d50cdab568, [result.createdCount]));
          if (result.skippedCount > 0) parts.push(localeFormat(localeCopy.copy_01ed9fb4f4, [result.skippedCount]));
          if (result.backfilledCount > 0) parts.push(localeFormat(localeCopy.copy_1f152441c7, [result.backfilledCount]));
          const msg = parts.length > 0 ? parts.join('，') : localeCopy.copy_2b3035d391;
          wx.showToast({ title: msg, icon: 'success' });
          this.loadPublicationData(this.data.publicationForm.activityId);
        } else {
          wx.showToast({ title: result.message || localeCopy.copy_9662ceba48, icon: 'none' });
        }
      } catch (e) { wx.showToast({ title: localeCopy.copy_9662ceba48, icon: 'none' }); }
      this.setLoading('generatePubMeritRules', false);
    },
  
    // ─── Designation Picker (uses clauseId) ───,

    async openDesignationPicker(e) {
      const ds = e.currentTarget.dataset;
      const clauseId = ds.clauseId; const pubId = ds.pubId;
      if (!clauseId || !pubId) { wx.showToast({ title: localeCopy.copy_157f5cd8f8, icon: 'none' }); return; }
  
      // Show popup immediately with loading state
      this.setData({ showDesignationPicker: true, designationPickerClauseId: clauseId, designationPickerPubId: pubId, designationPickerHrList: [], designationPickerFilteredList: [], designationPickerSelectedIds: [], designationPickerSelectedList: [], desigSearchKeyword: '', desigFilterDept: localeCopy.copy_31d4595959, desigFilterIdent: localeCopy.copy_31d4595959, desigFilterDeptOptions: [localeCopy.copy_31d4595959], desigFilterIdentOptions: [localeCopy.copy_31d4595959] });
  
      try {
        // Reload publication data to get latest clause info and designations
        await this.loadPublicationData(this.data.publicationForm.activityId);
        const allClauses = [];
        for (const rule of this.data.pubMeritRuleList) {
          for (const c of (rule.clauses || [])) {
            allClauses.push({
              ...c,
              granteeDepartmentId: rule.granteeDepartmentId,
              granteeIdentityId: rule.granteeIdentityId
            });
          }
        }
        const clause = allClauses.find(c => c.id === clauseId);
        if (!clause) { wx.showToast({ title: localeCopy.copy_02e1583d4a, icon: 'none' }); this.setData({ showDesignationPicker: false }); return; }
  
        const granteeDeptId = clause.granteeDepartmentId || '';
        const granteeIdentityId = clause.granteeIdentityId || '';
        const scopeType = clause.scopeType || 'all_people';
        const targetIdentityId = clause.targetIdentityId || '';
  
        const assignmentCandidates = (this.data.publicationAssignmentCandidates || []).map(function(candidate) {
          return { ...candidate, hrId: candidate.targetHrId || '' };
        });
        const assignmentsByHrId = {};
        assignmentCandidates.forEach(function(candidate) {
          if (!assignmentsByHrId[candidate.hrId]) assignmentsByHrId[candidate.hrId] = [];
          assignmentsByHrId[candidate.hrId].push(candidate.assignmentId);
        });
        const currentIds = [];
        (this.data.designationList || []).filter(function(item) {
          return item.clauseId === clauseId;
        }).forEach(function(item) {
          const assignmentId = item.targetAssignmentId || item.assignmentId || '';
          if (assignmentId) {
            currentIds.push(assignmentId);
            return;
          }
          const legacyAssignments = assignmentsByHrId[item.targetHrId] || [];
          if (legacyAssignments.length === 1) currentIds.push(legacyAssignments[0]);
        });
        const currentIdSet = new Set(currentIds);
        const filtered = designationCandidateView.filterCandidatesForClause(assignmentCandidates, {
          scopeType,
          granteeDepartmentId: granteeDeptId,
          granteeIdentityId,
          targetIdentityId
        }).map(candidate => ({ ...candidate, isSelected: currentIdSet.has(candidate.assignmentId) }));
        const depts = new Set(filtered.map(candidate => candidate.department).filter(Boolean));
        const idents = new Set(filtered.map(candidate => candidate.identity).filter(Boolean));
        const selectedList = filtered.filter(candidate => candidate.isSelected);
        this.setData({
          designationPickerHrList: filtered, designationPickerFilteredList: filtered,
          designationPickerSelectedIds: currentIds, designationPickerSelectedList: selectedList,
          desigFilterDept: localeCopy.copy_31d4595959, desigFilterIdent: localeCopy.copy_31d4595959,
          desigFilterDeptOptions: [localeCopy.copy_31d4595959, ...Array.from(depts).sort((a,b) => a.localeCompare(b, 'zh-CN'))],
          desigFilterIdentOptions: [localeCopy.copy_31d4595959, ...Array.from(idents).sort((a,b) => a.localeCompare(b, 'zh-CN'))],
          desigSearchKeyword: ''
        });
      } catch (e) { console.error('openDesignationPicker error:', e); wx.showToast({ title: localeCopy.copy_e52119b17e, icon: 'none' }); }
    },

    closeDesignationPicker() { this.setData({ showDesignationPicker: false }); },

    confirmSharedDesignationPicker(e) {
      const detail = e.detail || {};
      this.setData({
        designationPickerSelectedIds: Array.isArray(detail.keys) ? detail.keys : [],
        designationPickerSelectedList: Array.isArray(detail.items) ? detail.items : []
      }, () => this.saveDesignations());
    },

    onDesignationPickerToggle(e) {
      const assignmentId = e.currentTarget.dataset.assignmentId;
      if (!assignmentId) return;
      const selected = [...this.data.designationPickerSelectedIds];
      const idx = selected.indexOf(assignmentId);
      if (idx >= 0) selected.splice(idx, 1); else selected.push(assignmentId);
      const hrList = this.data.designationPickerHrList.map(candidate => ({ ...candidate, isSelected: candidate.assignmentId === assignmentId ? !candidate.isSelected : candidate.isSelected }));
      this.setData({
        designationPickerSelectedIds: selected, designationPickerHrList: hrList,
        designationPickerFilteredList: this.applyDesigFilters(hrList),
        designationPickerSelectedList: hrList.filter(hr => hr.isSelected)
      });
    },

    applyDesigFilters(list, overrides) {
      let result = list || this.data.designationPickerHrList;
      const next = overrides || {};
      const department = Object.prototype.hasOwnProperty.call(next, 'department') ? next.department : this.data.desigFilterDept;
      const identity = Object.prototype.hasOwnProperty.call(next, 'identity') ? next.identity : this.data.desigFilterIdent;
      const keyword = Object.prototype.hasOwnProperty.call(next, 'keyword') ? next.keyword : this.data.desigSearchKeyword;
      if (department !== localeCopy.copy_31d4595959) result = result.filter(hr => hr.department === department);
      if (identity !== localeCopy.copy_31d4595959) result = result.filter(hr => hr.identity === identity);
      if (keyword) { const kw = keyword.toLowerCase(); result = result.filter(hr => (hr.name || '').toLowerCase().includes(kw) || (hr.studentId || '').toLowerCase().includes(kw) || (hr.assignmentLabel || '').toLowerCase().includes(kw)); }
      return result;
    },

    onDesigFilterChange(e) {
      const field = e.currentTarget.dataset.field;
      const options = field === 'identity' ? this.data.desigFilterIdentOptions : this.data.desigFilterDeptOptions;
      const value = options[Number(e.detail.value)] || localeCopy.copy_31d4595959;
      const patch = {};
      if (field === 'department') {
        patch.desigFilterDept = value;
        patch.designationPickerFilteredList = this.applyDesigFilters(null, { department: value });
      } else {
        patch.desigFilterIdent = value;
        patch.designationPickerFilteredList = this.applyDesigFilters(null, { identity: value });
      }
      this.setData(patch);
    },

    onDesigSearchInput(e) { const keyword = e.detail.value; this.setData({ desigSearchKeyword: keyword, designationPickerFilteredList: this.applyDesigFilters(null, { keyword }) }); },

    async saveDesignations() {
      const clauseId = this.data.designationPickerClauseId;
      const pubId = this.data.designationPickerPubId;
      const assignmentIds = this.data.designationPickerSelectedIds;
      this.setLoading('saveDesignations', true);
      try {
        const result = await this.callCloud('saveMeritListDesignations', { clauseId, publicationId: pubId, designationAssignmentIds: assignmentIds });
        if (result.status === 'success') { wx.showToast({ title: result.message || localeCopy.copy_0aacec2714, icon: 'success' }); this.closeDesignationPicker(); this.loadPublicationData(this.data.publicationForm.activityId); }
        else { wx.showToast({ title: result.message || localeCopy.copy_215e3c57da, icon: 'none' }); }
      } catch (e) { wx.showToast({ title: localeCopy.copy_215e3c57da, icon: 'none' }); }
      this.setLoading('saveDesignations', false);
    },
    // ─── Batch category creation (replaces old batch form) ───,

    buildPubScorerCategoryList() {
      if (!this.data.departmentList.length || !this.data.identityList.length) return;
      const list = []; const seen = new Set();
      for (const dept of this.data.departmentList) { for (const ident of this.data.identityList) { const key = dept.id + '::' + ident.id; if (seen.has(key)) continue; seen.add(key); list.push({ key, departmentId: dept.id, department: dept.name, identityId: ident.id, identity: ident.name }); } };
      const depts = new Set(); const idents = new Set();
      list.forEach(item => { depts.add(item.department); idents.add(item.identity); });
      this.setData({ pubBatchList: list, pubBatchFilteredList: list, pubBatchFilterOptions: { departments: [localeCopy.copy_31d4595959, ...Array.from(depts).sort((a,b) => a.localeCompare(b, 'zh-CN'))], identities: [localeCopy.copy_31d4595959, ...Array.from(idents).sort((a,b) => a.localeCompare(b, 'zh-CN'))] } });
    },

    onPubBatchFilterChange(e) { /* kept for compatibility */ },

    applyPubBatchFilter(filters) { /* kept for compatibility */ },

    toggleBatchSelection(e) { /* kept for compatibility */ },

    toggleSelectAllBatch() { /* kept for compatibility */ },

    reverseSelectBatch() { /* kept for compatibility */ },
  
    // Batch save: apply current view clauses to selected view rule categories,

    async batchSavePubViewRules() {
      if (this.data.pubBatchRunning) { wx.showToast({ title: localeCopy.copy_f7dbdfa4c2, icon: 'none' }); return; }
      const pubId = this.data.publicationForm.id;
      if (!pubId) { wx.showToast({ title: localeCopy.copy_0dff72de43, icon: 'none' }); return; }
      const templateClauses = (this.data.pubViewRuleForm.clauses || []).map(c => ({ scopeType: c.scopeType, targetIdentityId: c.targetIdentityId, displayMode: c.displayMode || 'score', gradeBands: c.displayMode === 'grade' ? (c.gradeBands || []) : [] }));
      const selected = (this.data.pubViewRuleList || []).filter(item => this.data.pubViewRuleSelectedIds[item.id]);
      if (!selected.length) { wx.showToast({ title: localeCopy.copy_78e3986a7f, icon: 'none' }); return; }
      this.setData({ pubBatchRunning: true });
      this.setLoading('batchSavePubViewRules', true);
      try {
        const rules = selected.map(item => ({
          id: item.id,
          publicationId: pubId,
          granteeDepartmentId: item.granteeDepartmentId,
          granteeIdentityId: item.granteeIdentityId,
          clauses: templateClauses
        }));
        const result = await this.callCloud('batchSavePubViewRules', { rules });
        if (result.status === 'success') {
          wx.showToast({ title: localeFormat(localeCopy.copy_9d5c7b0e2b, [result.count || selected.length]), icon: 'success' });
        } else {
          wx.showToast({ title: result.message || localeCopy.copy_0531ed9e78, icon: 'none' });
        }
        await this.loadPublicationData(this.data.publicationForm.activityId);
      } catch (e) { wx.showToast({ title: localeCopy.copy_0531ed9e78, icon: 'none' }); }
      finally {
        this.setLoading('batchSavePubViewRules', false);
        this.setData({ pubBatchRunning: false });
      }
    },
  
    // Batch save: apply current merit clauses to selected merit rule categories,

    async batchSavePubMeritRules() {
      if (this.data.pubBatchRunning) { wx.showToast({ title: localeCopy.copy_f7dbdfa4c2, icon: 'none' }); return; }
      const pubId = this.data.publicationForm.id;
      if (!pubId) { wx.showToast({ title: localeCopy.copy_0dff72de43, icon: 'none' }); return; }
      const templateClauses = (this.data.pubMeritRuleForm.clauses || []).map(c => ({ scopeType: c.scopeType, targetIdentityId: c.targetIdentityId, quotaLimit: c.quotaLimit || 0, requireExactQuota: c.requireExactQuota || false }));
      const selected = (this.data.pubMeritRuleList || []).filter(item => this.data.pubMeritRuleSelectedIds[item.id]);
      if (!selected.length) { wx.showToast({ title: localeCopy.copy_78e3986a7f, icon: 'none' }); return; }
      this.setData({ pubBatchRunning: true });
      this.setLoading('batchSavePubMeritRules', true);
      try {
        const rules = selected.map(item => ({
          id: item.id,
          publicationId: pubId,
          granteeDepartmentId: item.granteeDepartmentId,
          granteeIdentityId: item.granteeIdentityId,
          clauses: templateClauses
        }));
        const result = await this.callCloud('batchSavePubMeritRules', { rules });
        if (result.status === 'success') {
          wx.showToast({ title: localeFormat(localeCopy.copy_9d5c7b0e2b, [result.count || selected.length]), icon: 'success' });
        } else {
          wx.showToast({ title: result.message || localeCopy.copy_0531ed9e78, icon: 'none' });
        }
        await this.loadPublicationData(this.data.publicationForm.activityId);
      } catch (e) { wx.showToast({ title: localeCopy.copy_0531ed9e78, icon: 'none' }); }
      finally {
        this.setLoading('batchSavePubMeritRules', false);
        this.setData({ pubBatchRunning: false });
      }
    }
  }
});
