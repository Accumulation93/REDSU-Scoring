const localeCopy = require('../../../../locales/zh-CN/generated/subpackages/venue/pages/pendingVenueApprovals/pendingVenueApprovals');
const { callFunction, getErrorText, showShortToast } = require('../../../../utils/api');
const { buildFlowTimeline } = require('../../utils/flowTimeline');
const eventBus = require('../../../../utils/eventBus');
const personnelPickerCopy = require('../../../../locales/zh-CN/personnelPicker');
const personnelPickerModel = require('../../../../components/personnel-picker/personnelPickerModel');
const orgSession = require('../../../../utils/orgSession');
const { navigateToTrustedRoute } = require('../../../../utils/trustedNavigation');
const { formatSystemClock } = require('../../../../utils/dateTime');
const {
  decoratePendingBooking,
  decorateApproverCandidates,
  showWorkContextModal
} = require('../../utils/workContextPresentation');

function isFlowApprovalTarget(record) {
  const target = record && typeof record === 'object' ? record : {};
  const progress = target.approvalProgress && typeof target.approvalProgress === 'object'
    ? target.approvalProgress
    : target;
  const flowId = progress.flowId === undefined ? target.approvalFlowId : progress.flowId;
  const currentStep = progress.currentStep === undefined
    ? target.approvalCurrentStep
    : progress.currentStep;
  const stepText = currentStep === null || currentStep === undefined ? '' : String(currentStep).trim();
  const stepIndex = Number(currentStep);
  return Boolean(String(flowId || '').trim())
    && Boolean(stepText)
    && Number.isInteger(stepIndex)
    && stepIndex >= 0;
}

function resolveVenueApprovalEndpoint(record, action) {
  const flowManaged = isFlowApprovalTarget(record);
  if (action === 'approve') {
    return flowManaged ? 'approveVenueBookingStep' : 'approveVenueBooking';
  }
  return flowManaged ? 'rejectVenueBookingStep' : 'rejectVenueBooking';
}

Page({
  onLoad() {
    wx.setNavigationBarTitle({ title: localeCopy.navigationTitle });
  },
  data: {
    localeCopy,
    pending: [],
    loading: false,
    lastUpdateTime: '',
    pendingHeaderText: localeCopy.copy_1fc8f9baba,
    lastPendingCount: 0,
    lastPendingSignature: '',

    // Approval popup
    approvalVisible: false,
    approvalTarget: null,       // the booking being approved/rejected
    approvalAction: '',         // 'approve' | 'reject'
    approvalComment: '',
    approvalSubmitting: false,
    canDesignateNext: false,
    nextApproverPickerVisible: false,
    nextApproverCandidates: [],
    nextApproverAssignmentIds: [],
    nextApproverSelections: [],
    nextApproverName: '',

    // ── Expandable flow ──
    expandedNodeKey: '',
  },

  _pollTimer: null,
  _approvalSyncTimer: null,
  _isPageVisible: true,

  onShow() {
    this._isPageVisible = true;
    const organizationState = orgSession.consume(this);
    if (organizationState.changed) {
      this._clearApprovalSyncTimer();
      orgSession.invalidateRequests(this);
      this.setData({
        pending: [], lastPendingCount: 0, lastPendingSignature: '', lastUpdateTime: '',
        pendingHeaderText: localeCopy.copy_1fc8f9baba,
        approvalVisible: false, approvalTarget: null, expandedNodeKey: '', loading: false
      });
    }
    this.loadData();
    this.startPolling();
    if (!this._boundVenueChanged) {
      this._boundVenueChanged = this._onVenueChanged.bind(this);
      eventBus.on('venue:changed', this._boundVenueChanged);
    }
  },

  onHide() {
    this._isPageVisible = false;
    this._clearApprovalSyncTimer();
    this.stopPolling();
    if (this._boundVenueChanged) {
      eventBus.off('venue:changed', this._boundVenueChanged);
      this._boundVenueChanged = null;
    }
  },

  onUnload() {
    this._isPageVisible = false;
    this._clearApprovalSyncTimer();
    this.stopPolling();
    if (this._boundVenueChanged) {
      eventBus.off('venue:changed', this._boundVenueChanged);
      this._boundVenueChanged = null;
    }
  },

  _onVenueChanged() {
    if (this._isPageVisible) this.loadData();
  },

  _buildPendingSignature(pending) {
    return (pending || []).map(function(item) {
      return [
        item.id,
        item.status,
        item.approvalCurrentStep,
        item.approvalTotalSteps,
        item.currentStepName,
        item.currentFlowId,
        item.canProcessInCurrentContext === true ? '1' : '0',
        item.candidateMissing === true ? '1' : '0',
        (item.flowSummary || []).map(function(flow) {
          return [flow.flowId, flow.stepIndex, flow.active ? 1 : 0, flow.completed ? 1 : 0,
            flow.superseded ? 1 : 0, Object.keys(flow.designated || {}).join(',')].join(',');
        }).join(';'),
        item.createdAt
      ].join(':');
    }).sort().join('|');
  },

  onPullDownRefresh() {
    let that = this;
    this.loadData().then(function() {
      wx.stopPullDownRefresh();
    });
  },

  // ═══ Polling ═══
  startPolling() {
    this.stopPolling();
    let that = this;
    this._pollTimer = setInterval(function() {
      if (that._isPageVisible) {
        that.checkForUpdates();
      }
    }, 30000);
  },

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  _clearApprovalSyncTimer() {
    if (!this._approvalSyncTimer) return;
    clearTimeout(this._approvalSyncTimer);
    this._approvalSyncTimer = null;
  },

  _scheduleApprovalSync() {
    this._clearApprovalSyncTimer();
    const request = orgSession.beginRequest(this, 'pendingVenueApprovalSyncDelay');
    this._approvalSyncTimer = setTimeout(() => {
      this._approvalSyncTimer = null;
      if (!this._isPageVisible || !orgSession.isRequestCurrent(this, request)) return;
      this.loadData();
    }, 2000);
  },

  async checkForUpdates() {
    try {
      let res = await callFunction({ name: 'listPendingVenueApprovals', data: {} });
      if (res.status === 'success') {
        let pending = res.pending || [];
        let count = pending.length;
        let signature = this._buildPendingSignature(pending);
        if (count !== this.data.lastPendingCount || signature !== this.data.lastPendingSignature) {
          this.loadData();
        } else if (count > 0) {
          this.setData({ lastUpdateTime: this._formatTime() });
        }
      }
    } catch (e) {
      // Silently ignore poll failures
    }
  },

  async loadData() {
    const request = orgSession.beginRequest(this, 'pendingVenueApprovals');
    this.setData({ loading: true });
    try {
      let res = await callFunction({ name: 'listPendingVenueApprovals', data: {} });
      if (!orgSession.isRequestCurrent(this, request)) return;
      if (res.status === 'success') {
        let pending = (res.pending || []).map(function(rawItem) {
          const item = decoratePendingBooking(rawItem);
          if (item.approvalTotalSteps > 0) {
            item._approvalPercent = Math.round(item.approvalCurrentStep / item.approvalTotalSteps * 100);
          } else {
            item._approvalPercent = 0;
          }
          // Build full flow timeline using shared utility
          item._flowTimeline = buildFlowTimeline({
            totalSteps: item.approvalTotalSteps,
            currentStep: item.approvalCurrentStep,
            isApproved: item.approvalCurrentStep >= item.approvalTotalSteps,
            isRejected: false,
            rejectStep: -1,
            flowId: item.currentFlowId,
            flowSteps: item.flowSteps || [],
            snapshots: item.snapshots || []
          });
          return item;
        });
        this.setData({
          pending: pending,
          lastPendingCount: pending.length,
          lastPendingSignature: this._buildPendingSignature(pending),
          lastUpdateTime: this._formatTime(),
          pendingHeaderText: pending.length ? (localeCopy.copy_1264209cb6 + this._formatTime()) : localeCopy.copy_1fc8f9baba
        });
      } else if (res.status === 'forbidden') {
        showShortToast(res.message || localeCopy.copy_bba7f8b8ba);
      } else {
        showShortToast(res.message || localeCopy.copy_e52119b17e);
      }
    } catch (e) {
      showShortToast(getErrorText(e, localeCopy.copy_e52119b17e));
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ loading: false });
    }
  },

  _formatTime() {
    return formatSystemClock(Date.now(), true);
  },

  // ═══ Approval actions ═══

  openApprove(e) {
    let id = e.currentTarget.dataset.id;
    let item = this.data.pending.find(function(p) { return p.id === id; });
    if (!item) return;
    if (!this._guardApprovalContext(item)) return;
    const flow = (item.flowSummary || []).find(function(current) {
      return current.flowId === item.currentFlowId;
    });
    const canDesignateNext = flow
      && flow.allowDesignateNext
      && Number(flow.stepIndex) + 1 < Number(flow.totalSteps);
    this.setData({
      approvalVisible: true,
      approvalTarget: item,
      approvalAction: 'approve',
      approvalComment: '',
      canDesignateNext: Boolean(canDesignateNext),
      nextApproverAssignmentIds: [],
      nextApproverSelections: [],
      nextApproverName: ''
    });
  },

  goApprovalHistory() {
    navigateToTrustedRoute('/subpackages/venue/pages/venueApprovalHistory/venueApprovalHistory');
  },

  openReject(e) {
    let id = e.currentTarget.dataset.id;
    let item = this.data.pending.find(function(p) { return p.id === id; });
    if (!item) return;
    if (!this._guardApprovalContext(item)) return;
    this.setData({
      approvalVisible: true,
      approvalTarget: item,
      approvalAction: 'reject',
      approvalComment: ''
    });
  },

  closeApproval() {
    this.setData({ approvalVisible: false, approvalTarget: null, approvalAction: '', approvalComment: '', expandedNodeKey: '' });
  },

  onApprovalCommentInput(e) {
    this.setData({ approvalComment: e.detail.value });
  },

  async openNextApproverPicker() {
    try {
      const target = this.data.approvalTarget;
      if (!target) return;
      const res = await callFunction({
        name: 'listVenueApproverCandidates',
        data: { bookingId: target.id, flowId: target.currentFlowId }
      });
      if (res.status === 'success') {
        this.setData({
          nextApproverPickerVisible: true,
          nextApproverCandidates: decorateApproverCandidates(res.candidates)
        });
      } else showShortToast(res.message || localeCopy.copy_e58fa637eb);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_e58fa637eb)); }
  },

  closeNextApproverPicker() {
    this.setData({ nextApproverPickerVisible: false });
  },

  confirmNextApprovers(e) {
    const detail = e.detail || {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    this.setData({
      nextApproverAssignmentIds: Array.isArray(detail.keys) ? detail.keys : [],
      nextApproverSelections: items,
      nextApproverName: personnelPickerModel.selectionSummary(items, personnelPickerCopy.selectedCount(items.length)),
      nextApproverPickerVisible: false
    });
  },

  async submitApproval() {
    let that = this;
    let target = this.data.approvalTarget;
    let action = this.data.approvalAction;
    let comment = this.data.approvalComment;

    if (!target || !action || !this._guardApprovalContext(target)) return;

    let endpoint = resolveVenueApprovalEndpoint(target, action);
    let actionLabel = action === 'approve' ? localeCopy.copy_8e2f75159e : localeCopy.copy_b4432643e3;

    this.setData({ approvalSubmitting: true });
    try {
      let res = await callFunction({
        name: endpoint,
        data: {
          id: target.id,
          comment: comment,
          flowId: target.currentFlowId,
          nextApproverAssignmentIds: action === 'approve' ? (this.data.nextApproverAssignmentIds || []) : []
        }
      });
      if (res.status === 'success') {
        showShortToast(res.message || (localeCopy.copy_f658e7b4d0 + actionLabel));
        that.closeApproval();

        const targetId = target.id;
        const pending = that.data.pending.filter(function(item) { return item.id !== targetId; });
        that.setData({
          pending: pending,
          lastPendingCount: pending.length,
          lastPendingSignature: that._buildPendingSignature(pending),
          lastUpdateTime: that._formatTime()
        });

        eventBus.emit('venue:changed', { reason: action, bookingId: targetId });
        eventBus.emit('approval:done');

        // 自动通过可能跨越多步；只接受服务端重新计算后的权威待办，禁止手工猜测下一步。
        await that.loadData();
      } else if (res.status === 'forbidden') {
        showWorkContextModal({
          content: res.message || localeCopy.requiredContextGeneric,
          onConfirm: this.goWorkContextSwitch.bind(this)
        });
      } else {
        showShortToast(res.message || localeCopy.copy_0531ed9e78);
      }
    } catch (e) {
      showShortToast(getErrorText(e, localeCopy.copy_0531ed9e78));
    } finally {
      this.setData({ approvalSubmitting: false });
    }
  },

  // ═══ Navigation ═══

  viewDetail(e) {
    let id = e.currentTarget.dataset.id;
    let item = this.data.pending.find(function(p) { return p.id === id; });
    if (item) {
      this.setData({
        approvalVisible: true,
        approvalTarget: item,
        approvalAction: '',
        approvalComment: ''
      });
    }
  },

  _guardApprovalContext(item) {
    if (item && item.canProcessInCurrentContext === true) return true;
    const required = item && item._requiredContextText;
    showWorkContextModal({
      content: required
        ? localeCopy.requiredContextPrefix + required
        : localeCopy.requiredContextGeneric,
      onConfirm: this.goWorkContextSwitch.bind(this)
    });
    return false;
  },

  goWorkContextSwitch() {
    navigateToTrustedRoute('/subpackages/org/pages/identitySwitch/identitySwitch');
  },

  // ── Expandable flow ──
  toggleFlowNode(e) {
    let key = e.currentTarget.dataset.nodeKey;
    this.setData({ expandedNodeKey: this.data.expandedNodeKey === key ? '' : key });
  },

  noop() {}
});
