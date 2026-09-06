const localeCopy = require('../../../../locales/zh-CN/generated/subpackages/venue/pages/venueManage/venueManage');
const { callFunction, getErrorText, showShortToast } = require('../../../../utils/api');
const { buildFlowTimeline } = require('../../utils/flowTimeline');
const eventBus = require('../../../../utils/eventBus');
const orgSession = require('../../../../utils/orgSession');
const adminPermissions = require('../../../../utils/adminPermissions');
const { buildBookingRuleDisplayList } = require('../../utils/venueRuleDisplay');
const flowManagementCopy = require('../../../../locales/zh-CN/venueFlowManagement');
const { navigateToTrustedRoute } = require('../../../../utils/trustedNavigation');
const { prepareVenueBookingDetail } = require('../../utils/venueBookingDetail');
const {
  getSystemDate,
  getSystemWeekStart,
  addDateDays
} = require('../../../../utils/dateTime');

const HOURS = ['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00','24:00'];
const HOUR_HEIGHT = 64; // rpx per hour
const BASE_MIN = 0;
const HEADER_H = 58; // rpx — matches .tt-time-header height
const TEXT_OFFSET = 22; // rpx — align block top with time-label text (centered 19rpx text in 64rpx row)
const BOOKING_PURPOSE_MAX_LENGTH = 200;

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

// Synchronous scroll tracking (NOT in this.data — setData is async, can't rely on it)
let _timetableScrollTop = 0;

function unicodeLength(value) {
  return Array.from(String(value || '')).length;
}

const ALL_MINUTES = [];
for (let i = 0; i < 60; i++) {
  ALL_MINUTES.push({ value: i, label: String(i).padStart(2, '0') });
}

function slotsToIntervals(slots) {
  return (slots || []).map(s => ({ start: timeToMin(s.timeStart), end: timeToMin(s.timeEnd) }));
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

function findOpenGap(rangeStart, rangeEnd, mergedOpen) {
  let cursor = rangeStart;
  for (const iv of mergedOpen) {
    if (iv.start > cursor) return cursor;
    if (iv.end > cursor) cursor = iv.end;
    if (cursor >= rangeEnd) return -1;
  }
  return cursor < rangeEnd ? cursor : -1;
}

function findBlockedOverlap(rangeStart, rangeEnd, mergedBlocked) {
  for (const iv of mergedBlocked) {
    if (iv.start < rangeEnd && iv.end > rangeStart) return iv;
  }
  return null;
}

function timeToMin(t) {
  if (!t) return 0;
  const parts = String(t).split(':');
  return (parseInt(parts[0])||0)*60 + (parseInt(parts[1])||0);
}

/** Compute display status from db status + time comparison */
function computeDisplayStatus(item) {
  if (item.status === 'pending') return 'pending';
  if (item.status === 'rejected') return 'rejected';
  if (item.status === 'cancelled') return 'cancelled';
  if (item.status === 'approved') {
    const now = new Date();
    const timeStart = new Date(item.timeStart.replace(' ', 'T'));
    const timeEnd = new Date(item.timeEnd.replace(' ', 'T'));
    if (now < timeStart) return 'approved';
    if (now >= timeEnd) return 'completed';
    return 'inUse';
  }
  return item.status;
}

function calcBlock(timeStart, timeEnd) {
  const s = timeToMin(timeStart);
  const e = timeToMin(timeEnd);
  const top = Math.round((s - BASE_MIN) / 60 * HOUR_HEIGHT);
  const height = Math.max(Math.round((e - s) / 60 * HOUR_HEIGHT), 20);
  return { top, height };
}

/** Build checked arrays from cycleValues (WXML can't call indexOf) */
function buildWeeklyChecked(cycleValues) {
  const arr = [false, false, false, false, false, false, false];
  const values = Array.isArray(cycleValues) ? cycleValues : ((cycleValues && cycleValues.values) || []);
  values.forEach(v => { const n = Number(v); if (n >= 1 && n <= 7) arr[n - 1] = true; });
  return arr;
}

function buildMonthlyChecked(cycleValues) {
  const arr = Array(31).fill(false);
  const values = Array.isArray(cycleValues) ? cycleValues : ((cycleValues && cycleValues.values) || []);
  values.forEach(v => { const n = Number(v); if (n >= 1 && n <= 31) arr[n - 1] = true; });
  return arr;
}

/** Parse comma-separated ID string into array */
function parseCsvArray(str) {
  if (!str) return [];
  return String(str).split(',').map(s => s.trim()).filter(Boolean);
}

function emptyActivityCycleValues() {
  return { values: [], periodMode: 'none', periodStartDate: '', periodStartTime: '00:00', periodEndDate: '', periodEndTime: '23:59', repeatCount: 0 };
}

function normalizeActivityCycleValues(cycleType, values) {
  let parsed = values;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_) { parsed = []; }
  }
  if (cycleType === 'datetime_range') {
    return { ...emptyActivityCycleValues(), periodMode: 'range', periodStartDate: parsed.startDate || '', periodStartTime: parsed.startTime || '00:00', periodEndDate: parsed.endDate || '', periodEndTime: parsed.endTime || '23:59' };
  }
  if (cycleType === 'repeat') {
    return { ...emptyActivityCycleValues(), periodMode: 'count', periodStartDate: parsed.startDate || '', periodStartTime: parsed.startTime || '00:00', repeatCount: Number(parsed.repeatCount) || 0 };
  }
  if (Array.isArray(parsed)) return { ...emptyActivityCycleValues(), values: parsed };
  if (parsed && Array.isArray(parsed.values)) {
    const inferredMode = ['none', 'range', 'count'].includes(parsed.periodMode)
      ? parsed.periodMode
      : (parsed.repeatCount > 0 && !parsed.periodEndDate ? 'count' : (parsed.periodStartDate || parsed.periodEndDate ? 'range' : 'none'));
    return { ...emptyActivityCycleValues(), ...parsed, periodMode: inferredMode, values: parsed.values };
  }
  if (parsed && (parsed.startDate || parsed.endDate)) return { ...emptyActivityCycleValues(), periodMode: 'range', periodStartDate: parsed.startDate || '', periodEndDate: parsed.endDate || '' };
  return emptyActivityCycleValues();
}

function activityCycleTypeIndex(cycleType) {
  const types = ['daily', 'weekly', 'monthly', 'yearly'];
  const index = types.indexOf(cycleType);
  return index >= 0 ? index : 0;
}

function formatActivityCycleLabel(type, values) {
  let parsed = values;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_) { parsed = {}; }
  }
  parsed = parsed || {};
  const meta = Array.isArray(parsed) ? emptyActivityCycleValues() : (parsed.periodStartDate || parsed.periodEndDate ? parsed : {
    ...parsed,
    periodStartDate: parsed.startDate || '',
    periodStartTime: parsed.startTime || '00:00',
    periodEndDate: parsed.endDate || '',
    periodEndTime: parsed.endTime || '23:59'
  });
  const mode = meta.periodMode || (Number(meta.repeatCount) > 0 && !meta.periodEndDate ? 'count' : (meta.periodStartDate || meta.periodEndDate ? 'range' : 'none'));
  if (mode === 'none') return localeCopy.copy_dae9f72578;
  const start = meta.periodStartDate ? meta.periodStartDate + ' ' + (meta.periodStartTime || '00:00') : localeCopy.copy_f54e24d97d;
  if (mode === 'count') return localeCopy.copy_5bb8799355 + start + localeCopy.copy_ca51b9c6c6 + (Number(meta.repeatCount) || 0) + localeCopy.copy_c5aa06059a;
  const end = meta.periodEndDate ? meta.periodEndDate + ' ' + (meta.periodEndTime || '23:59') : localeCopy.copy_b8c87b0fb5;
  return localeCopy.copy_eeb5f0e78e + start + localeCopy.copy_c44dbba9e9 + end;
}

function emptyBookingWindow() {
  return {
    open: { mode: 'none', days: 7, hours: 0, minutes: 0 },
    deadline: { mode: 'none', days: 0, hours: 0, minutes: 0 }
  };
}

function bookingWindowFromRow(row) {
  const window = emptyBookingWindow();
  if (!row) return window;
  const openMinutes = row.openAdvanceMinutes === null || row.openAdvanceMinutes === undefined
    ? null : Number(row.openAdvanceMinutes);
  const deadlineMinutes = row.deadlineAdvanceMinutes === null || row.deadlineAdvanceMinutes === undefined
    ? null : Number(row.deadlineAdvanceMinutes);
  if (row.openAdvanceMode) {
    window.open.mode = row.openAdvanceMode;
    if (row.openAdvanceMode === 'days') window.open.days = Number(row.openAdvanceDays) || 0;
    else if (openMinutes !== null) {
      window.open.hours = Math.floor(openMinutes / 60);
      window.open.minutes = openMinutes % 60;
    }
  }
  if (row.deadlineAdvanceMode) {
    window.deadline.mode = row.deadlineAdvanceMode;
    if (row.deadlineAdvanceMode === 'days') window.deadline.days = Number(row.deadlineAdvanceDays) || 0;
    else if (deadlineMinutes !== null) {
      window.deadline.hours = Math.floor(deadlineMinutes / 60);
      window.deadline.minutes = deadlineMinutes % 60;
    }
  }
  return window;
}

function bookingWindowMinutes(item) {
  if (!item || item.mode === 'none') return null;
  if (item.mode === 'days') return Math.max(0, Number(item.days) || 0) * 24 * 60;
  return Math.max(0, Number(item.hours) || 0) * 60 + Math.max(0, Number(item.minutes) || 0);
}

Page({
  data: {
    localeCopy,
    flowManagementCopy,
    // ── Main tab ──
    activeTab: 'venue',  // 'venue' | 'bookings' | 'pending' | 'purposes'
    hasPermission: true,
    canApproveVenue: false,
    currentOrganizationName: '',
    adminDisplayName: localeCopy.copy_c01a9aef59,
    adminLevelLabel: localeCopy.copy_fd31650797,
    visibleTabs: [
      { key: 'venue', label: localeCopy.copy_ceffdfcdd7 },
      { key: 'bookings', label: localeCopy.copy_20ba89a1cc },
      { key: 'pending', label: localeCopy.copy_e7f0a24301 },
      { key: 'purposes', label: localeCopy.copy_8dcf3fcf0b }
    ],

    venues: [],
    loading: false,
    editing: false,
    editId: '',
    editName: '',
    editLocation: '',
    editDesc: '',

    // Rules popup for selected venue
    rulesVisible: false,
    rulesVenueId: '',
    rulesVenueName: '',
    rulesTab: 'open', // 'open' | 'activity' | 'booking' | 'flow'
    openRules: [],
    activityRules: [],
    activityDetailVisible: false,
    activityDetail: null,
    bookingRules: [],

    // Approval flow management
    approvalFlow: null,
    approvalFlowSteps: [],
    approvalFlows: [],
    selectedFlowId: '',
    selectedFlowName: '',
    allowUserSelectFlow: false,
    allowDesignateFirstFlow: false,
    allowDesignateNextFlow: false,
    flowEditorVisible: false,
    flowEditStepIdx: -1,       // -1 = adding new step at end
    flowEditStepName: '',
    flowEditStepRules: [],     // [{ deptScope:'all', deptIds:'', wgScope:'all', wgIds:'', identScope:'all', identIds:'' }]
    flowEditRuleIdx: -1,       // -1 = adding new rule at end, -2 = not editing rule
    flowEditRuleForm: {
      departmentScope: 'all', specificDepartmentId: '',
      workGroupScope: 'all', specificWorkGroupId: '',
      identityScope: 'all', specificIdentityId: ''
    },
    // Reference data for pickers (loaded from API)
    allDepartments: [],
    allWorkGroups: [],

    // Condition multi-picker
    condMultiPickerVisible: false,
    condMultiPickerTarget: '',
    condMultiPickerTitle: '',
    condMultiPickerItems: [],
    condMultiPickerSelectedIds: {},
    condMultiPickerSelectedCount: 0,
    condMultiPickerSearch: '',
    condMultiPickerFilteredList: [],
    condMultiPickerDeptTabs: [],
    condMultiPickerActiveDeptTab: '',
    bookingWindow: null,
    bookingWindowForm: emptyBookingWindow(),
    advanceHourOptions: Array.from({ length: 721 }, (_, index) => String(index) + localeCopy.copy_7bbe7387fa),
    advanceMinuteOptions: Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0') + localeCopy.copy_4f57bde8f7),

    // Rule editor
    ruleEditorVisible: false,
    ruleEditId: '',
    ruleEditorType: '',
    ruleEditorScrollStyle: '',
    ruleEditorScrollIntoView: '',
    ruleForm: { name: '', cycleType: 'weekly', cycleValues: [], _cycleTypeIndex: 1, timeStart: '09:00', timeEnd: '18:00', ruleType: 'admin', bookingWindow: emptyBookingWindow() },

    // Reference data
    allIdentities: [],
    allHrPersons: [],

    // Yearly date picker state
    yearlyPickMonth: 1,
    yearlyPickDay: 1,
    yearlyDays: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],

    // Yearly range picker state
    yearlyRangeStartMonth: 1,
    yearlyRangeStartDay: 1,
    yearlyRangeEndMonth: 1,
    yearlyRangeEndDay: 1,
    openCycleTypeOptions: [localeCopy.copy_13293d504a, localeCopy.copy_1a6678cddf, localeCopy.copy_06a9527bac, localeCopy.copy_9084e6bc76, localeCopy.copy_652116de6d],
    activityCycleTypeOptions: [localeCopy.copy_13293d504a, localeCopy.copy_1a6678cddf, localeCopy.copy_06a9527bac, localeCopy.copy_9084e6bc76],

    // Pre-computed checked arrays for WXML (indexOf not supported in templates)
    weeklyChecked: [false, false, false, false, false, false, false],
    monthlyChecked: Array(31).fill(false),

    // Timetable schedule view
    scheduleVisible: false,
    scheduleVenueId: '',
    scheduleVenueName: '',
    scheduleWeekStart: '',
    timetableColumns: [],
    timetableScrollTop: 0,
    // Pre-computed for data-time binding (same approach as data-date)
    HOUR_HEIGHT: HOUR_HEIGHT,
    HEADER_H: HEADER_H,
    halfHourTimes: (() => {
      const arr = [];
      for (let i = 0; i < 48; i++) {
        arr.push(String(Math.floor(i/2)).padStart(2,'0') + ':' + String((i%2)*30).padStart(2,'0'));
      }
      return arr;
    })(),
    timetableHours: HOURS,
    bookingDetailVisible: false,
    bookingDetail: null,

    // Admin quick booking from timetable
    adminBookingVisible: false,
    adminBookingVenueId: '',
    adminBookingVenueName: '',
    adminBookingStartDate: '',
    adminBookingStartDateDisplay: '',
    adminBookingEndDate: '',
    adminBookingEndDateDisplay: '',
    adminBookingTitle: '',
    adminBookingDesc: '',
    adminTimelineBlocks: [],
    adminTimelineSelection: null,
    adminBookingTimeStart: '',
    adminBookingTimeEnd: '',
    adminDailySlots: [],

    // Admin time picker options
    adminStartHours: [],
    adminStartHourIdx: 0,
    adminStartMinIdx: 0,
    adminEndHours: [],
    adminEndHourIdx: 0,
    adminEndMinIdx: 0,
    _adminDayData: null,

    // Shared minute options
    ALL_MINUTES: ALL_MINUTES,

    // ── Bookings tab (borrow management) ──
    bookings: [],
    bookingsLoading: false,
    occupiedPopupVisible: false, occupiedPopupTime: '',
    filterStatus: '',
    filterVenueId: '',
    timeFrom: '',
    timeTo: '',
    timeFromDisplay: '',
    timeToDisplay: '',
    statusLabels: { pending: localeCopy.copy_8f73640107, approved: localeCopy.copy_ce171a2581, rejected: localeCopy.copy_5d5af942c5, cancelled: localeCopy.copy_fd4601c1f9, inUse: localeCopy.copy_ad310c8780, completed: localeCopy.copy_2220286f1c },

    // Approval popup (step-aware approve/reject)
    approvalPopupVisible: false,
    approvalPopupId: '',
    approvalPopupAction: '',  // 'approve' | 'reject'
    approvalPopupComment: '',
    approvalPopupTarget: null,
    contextSwitchGuardVisible: false,

    // Purpose management
    purposeVisible: false,
    purposes: [],
    purposeEditId: '',
    purposeEditText: '',

    // ── Expandable flow ──
    expandedNodeKey: '',
  },

  onLoad(options) {
    wx.setNavigationBarTitle({ title: localeCopy.navigationTitle });
    // Support ?tab=bookings redirect from old venueBookings page
    if (options && options.tab) {
      this.setData({ activeTab: options.tab });
    }
  },

  onShow() {
    this.preparePermissionsAndLoad();
  },

  async preparePermissionsAndLoad() {
    const organizationState = orgSession.consume(this);
    this._orgContextVersion = organizationState.snapshot.version;
    if (organizationState.changed) {
      orgSession.invalidateRequests(this);
      const activeTab = this.data.activeTab;
      this.setData({
        activeTab,
        venueSearch: '', bookingSearch: '', bookingStatusFilter: 'all',
        bookingsPage: 1, selectedBooking: null, scheduleVisible: false,
        adminBookingVisible: false, occupiedPopupVisible: false, occupiedPopupTime: '', purposeEditId: '', purposeEditText: '',
        rulesVisible: false, ruleEditorVisible: false, bookingDetailVisible: false,
        venues: [], bookings: [], purposes: [], openRules: [], activityRules: [], bookingRules: [],
        approvalFlow: null, approvalFlowSteps: [], timetableColumns: [],
        loading: false, bookingsLoading: false
      });
    }
    let profile = adminPermissions.getAdminProfile();
    try {
      profile = await adminPermissions.refreshMyPermissions() || profile;
    } catch (error) {
      console.error('[venueManage] refresh permissions failed:', error.message || error);
    }
    const allTabs = [
      { key: 'venue', label: localeCopy.copy_ceffdfcdd7 },
      { key: 'bookings', label: localeCopy.copy_20ba89a1cc },
      { key: 'pending', label: localeCopy.copy_e7f0a24301 },
      { key: 'purposes', label: localeCopy.copy_8dcf3fcf0b }
    ];
    const allowedKeys = adminPermissions.filterTabs(allTabs.map(function(item) { return item.key; }), profile, adminPermissions.VENUE_TAB_PERMISSION_MAP);
    const visibleTabs = allTabs.filter(function(item) { return allowedKeys.indexOf(item.key) >= 0; });
    const activeTab = allowedKeys.indexOf(this.data.activeTab) >= 0 ? this.data.activeTab : (allowedKeys[0] || '');
    this.setData({
      visibleTabs: visibleTabs,
      activeTab: activeTab,
      hasPermission: visibleTabs.length > 0,
      canApproveVenue: adminPermissions.hasAny(profile, ['venue.approvals']),
      currentOrganizationName: orgSession.getSnapshot().orgName || '',
      adminDisplayName: profile && profile.name ? profile.name : localeCopy.copy_c01a9aef59,
      adminLevelLabel: profile && profile.adminLevel === 'super_admin' ? localeCopy.copy_ccd219e5f1 : localeCopy.copy_fd31650797
    });
    if (!visibleTabs.length) return;

    this._initWeekStart();
    this._initBookingsTimeRange();
    this.loadVenues();
    if (allowedKeys.indexOf('venue') >= 0) {
      this.loadReferenceData();
    }
    if (allowedKeys.indexOf('purposes') >= 0) this.loadPurposes();
    if (activeTab === 'bookings') {
      this.loadBookingsData();
    }
  },

  _initBookingsTimeRange() {
    const to = getSystemDate();
    const from = addDateDays(to, -7);
    this.setData({ timeFrom: from, timeTo: to, timeFromDisplay: from, timeToDisplay: to });
  },

  goPendingApprovals() {
    navigateToTrustedRoute('/subpackages/venue/pages/pendingVenueApprovals/pendingVenueApprovals');
  },

  onOrgTap() {
    const hasUnsavedWork = Boolean(
      this.data.editing ||
      this.data.ruleEditorVisible ||
      this.data.flowEditorVisible ||
      this.data.adminBookingVisible ||
      this.data.approvalPopupVisible ||
      this.data.condMultiPickerVisible ||
      this.data.purposeEditId ||
      this.data.purposeEditText
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

  // ── Main tab switching ──
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!(this.data.visibleTabs || []).some(function(item) { return item.key === tab; })) return;
    if (tab === 'pending') {
      this.goPendingApprovals();
      return;
    }
    this.setData({ activeTab: tab });
    if (tab === 'bookings') {
      this.loadBookingsData();
    }
    if (tab === 'purposes') {
      this.loadPurposes();
    }
  },

  async loadReferenceData() {
    const request = orgSession.beginRequest(this, 'manageReferences');
    try {
      const [identRes, hrRes] = await Promise.all([
        callFunction({ name: 'listIdentities', data: {} }),
        callFunction({ name: 'listHrInfo', data: {} })
      ]);
      if (!orgSession.isRequestCurrent(this, request)) return;
      this.setData({
        allIdentities: (identRes.status === 'success' ? identRes.identities : []) || [],
        allHrPersons: (hrRes.status === 'success' ? hrRes.list : []) || []
      }, () => this._refreshRuleEditorRuleLabels());
    } catch (_) {}
  },

  async loadVenues() {
    const request = orgSession.beginRequest(this, 'manageVenues');
    this.setData({ loading: true });
    try {
      const res = await callFunction({ name: 'listVenues', data: {} });
      if (!orgSession.isRequestCurrent(this, request)) return;
      if (res.status === 'success') this.setData({ venues: res.venues || [] });
    } catch (e) {
      if (orgSession.isRequestCurrent(this, request)) showShortToast(getErrorText(e, localeCopy.copy_e52119b17e));
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ loading: false });
    }
  },

  // ── Venue CRUD ──
  startAdd() {
    this.setData({ editing: true, editId: '', editName: '', editLocation: '', editDesc: '' });
  },

  startEdit(e) {
    const v = this.data.venues.find(v => v.id === e.currentTarget.dataset.id);
    if (!v) return;
    this.setData({ editing: true, editId: v.id, editName: v.name, editLocation: v.location || '', editDesc: v.description || '' });
  },

  cancelEdit() { this.setData({ editing: false }); },

  async saveVenue() {
    const { editId, editName, editLocation, editDesc } = this.data;
    if (!editName) { showShortToast(localeCopy.copy_4514e50856); return; }
    this.setData({ loading: true });
    try {
      const res = await callFunction({
        name: 'saveVenue',
        data: { id: editId, name: editName, location: editLocation, description: editDesc }
      });
      if (res.status === 'success') {
        showShortToast(res.message);
        this.setData({ editing: false });
        this.loadVenues();
      } else showShortToast(res.message);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_215e3c57da)); }
    finally { this.setData({ loading: false }); }
  },

  async deleteVenue(e) {
    const id = e.currentTarget.dataset.id;
    const that = this;
    wx.showModal({
      title: localeCopy.copy_7f31eec657, content: localeCopy.copy_8ec6962e84,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await callFunction({ name: 'deleteVenue', data: { id } });
          if (res.status === 'success') { showShortToast(localeCopy.copy_5398fec054); that.loadVenues(); }
          else showShortToast(res.message);
        } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_076bb5d383)); }
      }
    });
  },

  // ── Rules ──
  async openRules(e) {
    const id = e.currentTarget.dataset.id;
    const v = this.data.venues.find(v => v.id === id);
    this.setData({
      rulesVisible: true,
      rulesVenueId: id,
      rulesVenueName: v ? v.name : '',
      rulesTab: 'open',
      openRules: [],
      activityRules: [],
      activityDetailVisible: false,
      activityDetail: null,
      bookingRules: [],
      bookingWindow: null,
      bookingWindowForm: emptyBookingWindow(),
      approvalFlow: null,
      approvalFlowSteps: []
    });

    const initialLoads = [this.loadOpenRules(), this.loadActivityRules()];
    if (this.data.canApproveVenue) initialLoads.push(this.loadApprovalFlow());
    await Promise.all(initialLoads);
    if (this.data.canApproveVenue && this.data.rulesVenueId === id) {
      await this.loadBookingRules();
    }
  },

  closeRules() { this.setData({ rulesVisible: false }); },

  switchRulesTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ rulesTab: tab });
  },

  async loadOpenRules() {
    const request = orgSession.beginRequest(this, 'manageOpenRules');
    const venueId = this.data.rulesVenueId;
    try {
      const res = await callFunction({ name: 'listVenueOpenRules', data: { venueId } });
      if (!orgSession.isRequestCurrent(this, request) || this.data.rulesVenueId !== venueId) return;
      if (res.status === 'success') {
        const rules = (res.rules || []).map(r => ({
          ...r, _cycleLabel: this.getCycleLabel(r.cycle_type, r.cycle_values)
        }));
        this.setData({ openRules: rules });
      }
    } catch (_) {}
  },

  async loadActivityRules() {
    const request = orgSession.beginRequest(this, 'manageActivityRules');
    const venueId = this.data.rulesVenueId;
    try {
      const res = await callFunction({ name: 'listVenueActivityRules', data: { venueId } });
      if (!orgSession.isRequestCurrent(this, request) || this.data.rulesVenueId !== venueId) return;
      if (res.status === 'success') {
        const rules = (res.rules || []).map(r => ({
          ...r,
          _cycleLabel: this.getCycleLabel(r.cycle_type, r.cycle_values),
          _detailCycleLabel: formatActivityCycleLabel(r.cycle_type, r.cycle_values),
          _activitySummary: this.getCycleLabel(r.cycle_type, r.cycle_values) + ' · ' + (r.time_start || '09:00').substring(0, 5) + ' - ' + (r.time_end || '18:00').substring(0, 5) + ' · ' + formatActivityCycleLabel(r.cycle_type, r.cycle_values)
        }));
        this.setData({ activityRules: rules });
      }
    } catch (_) {}
  },

  async loadBookingRules() {
    const request = orgSession.beginRequest(this, 'manageBookingRules');
    const venueId = this.data.rulesVenueId;
    try {
      const res = await callFunction({ name: 'listVenueBookingRules', data: { venueId } });
      if (!orgSession.isRequestCurrent(this, request) || this.data.rulesVenueId !== venueId) return;
      if (res.status === 'success') {
        this.setData({
          bookingWindow: res.bookingWindow || null,
          bookingWindowForm: bookingWindowFromRow(res.bookingWindow),
          bookingRules: buildBookingRuleDisplayList(res.rules)
        });
      } else console.warn('[loadBookingRules] failed:', res.message);
    } catch (e) { console.error('[loadBookingRules] error:', e); }
  },

  // ── Rule Editor ──
  _resolveNames(idArray, sourceList) {
    if (!idArray || !idArray.length) return '';
    return idArray.map(id => {
      const item = (sourceList || []).find(it => String(it.id) === String(id));
      return item ? item.name : '';
    }).filter(Boolean).join('、');
  },

  _formatRuleScopeLabel(scope, ids, sourceList, label, sameLabel) {
    if (scope === 'specific') {
      const names = this._resolveNames(parseCsvArray(ids), sourceList);
      return label + '：' + (names || localeCopy.copy_8bc3aa5b58);
    }
    if (scope === 'same') return label + '：' + sameLabel;
    return label + localeCopy.copy_04d00bdf17;
  },

  _formatRuleScopeValue(scope, ids, sourceList, sameLabel) {
    if (scope === 'specific') return this._resolveNames(parseCsvArray(ids), sourceList) || localeCopy.copy_8bc3aa5b58;
    if (scope === 'same') return sameLabel;
    return localeCopy.copy_62676bc383;
  },

  _decorateRuleDisplay(rule) {
    const next = { ...(rule || {}) };
    next._departmentLabel = this._formatRuleScopeLabel(
      next.departmentScope, next.specificDepartmentId, this.data.allDepartments, localeCopy.copy_bc011e4e3b, localeCopy.copy_bb2dcb8a98
    );
    next._workGroupLabel = this._formatRuleScopeLabel(
      next.workGroupScope, next.specificWorkGroupId, this.data.allWorkGroups, localeCopy.copy_be736f763d, localeCopy.copy_9384e056f9
    );
    next._identityLabel = this._formatRuleScopeLabel(
      next.identityScope, next.specificIdentityId, this.data.allIdentities, localeCopy.copy_474f638a6f, localeCopy.copy_1deb0dba7e
    );
    next._departmentValue = this._formatRuleScopeValue(
      next.departmentScope, next.specificDepartmentId, this.data.allDepartments, localeCopy.copy_bb2dcb8a98
    );
    next._workGroupValue = this._formatRuleScopeValue(
      next.workGroupScope, next.specificWorkGroupId, this.data.allWorkGroups, localeCopy.copy_9384e056f9
    );
    next._identityValue = this._formatRuleScopeValue(
      next.identityScope, next.specificIdentityId, this.data.allIdentities, localeCopy.copy_1deb0dba7e
    );
    return next;
  },

  _decorateFlowSteps(steps) {
    return (steps || []).map(step => ({
      ...step,
      rules: (step.rules || []).map(rule => this._decorateRuleDisplay(rule))
    }));
  },

  _decorateEditingCondition(condition) {
    const next = { ...(condition || {}) };
    const display = this._decorateRuleDisplay({
      departmentScope: next.deptScope || 'all',
      specificDepartmentId: (next.deptIds || []).join(','),
      workGroupScope: next.wgScope || 'all',
      specificWorkGroupId: (next.wgIds || []).join(','),
      identityScope: next.identScope || 'all',
      specificIdentityId: (next.identIds || []).join(',')
    });
    next._deptNames = this._resolveNames(next.deptIds || [], this.data.allDepartments);
    next._wgNames = this._resolveNames(next.wgIds || [], this.data.allWorkGroups);
    next._identNames = this._resolveNames(next.identIds || [], this.data.allIdentities);
    next._departmentLabel = display._departmentLabel;
    next._workGroupLabel = display._workGroupLabel;
    next._identityLabel = display._identityLabel;
    next._departmentValue = display._departmentValue;
    next._workGroupValue = display._workGroupValue;
    next._identityValue = display._identityValue;
    return next;
  },

  _refreshRuleEditorRuleLabels() {
    if (!this.data.ruleEditorVisible) return;
    const ruleForm = this.data.ruleForm || {};
    const update = {
      'ruleForm._flowSteps': this._decorateFlowSteps(ruleForm._flowSteps || []),
      'ruleForm._editingStepRules': (ruleForm._editingStepRules || []).map(rule => this._decorateRuleDisplay(rule))
    };
    if (ruleForm._editingCondition) {
      update['ruleForm._editingCondition'] = this._decorateEditingCondition(ruleForm._editingCondition);
    }
    this.setData(update, () => this._scheduleRuleEditorViewportSync());
  },

  openRuleEditor(e) {
    const type = e.currentTarget.dataset.type; // 'open' | 'activity' | 'booking'
    const ruleId = e.currentTarget.dataset.id || '';
    let form = { name: '', cycleType: 'weekly', cycleValues: [], _cycleTypeIndex: type === 'activity' ? 1 : 1, timeStart: '09:00', timeEnd: '18:00', ruleType: 'admin', bookingWindow: bookingWindowFromRow(this.data.bookingWindow), approverIdentityId: '', approverHrId: '', approverIdentityName: '', approverHrName: '', approverIdentityIndex: 0, approverHrIndex: 0 };
    if (type === 'activity') form.cycleValues = emptyActivityCycleValues();
    if (ruleId) {
      if (type === 'open') {
        const r = this.data.openRules.find(r => r.id === ruleId);
        if (r) {
          const cv = typeof r.cycle_values === 'string' ? JSON.parse(r.cycle_values) : (r.cycle_values || []);
          form = { ...form, name: r.name || '', cycleType: r.cycle_type, cycleValues: cv, timeStart: (r.time_start || '09:00').substring(0, 5), timeEnd: (r.time_end || '18:00').substring(0, 5) };
        }
      } else if (type === 'activity') {
        const r = this.data.activityRules.find(r => r.id === ruleId);
        if (r) {
          const cv = typeof r.cycle_values === 'string' ? JSON.parse(r.cycle_values) : (r.cycle_values || []);
          const activityType = ['daily', 'weekly', 'monthly', 'yearly'].includes(r.cycle_type) ? r.cycle_type : 'daily';
          form = { ...form, name: r.activity_name || '', cycleType: activityType, _cycleTypeIndex: activityCycleTypeIndex(activityType), cycleValues: normalizeActivityCycleValues(r.cycle_type, cv), timeStart: (r.time_start || '09:00').substring(0, 5), timeEnd: (r.time_end || '18:00').substring(0, 5) };
        }
      } else if (type === 'booking') {
        const r = this.data.bookingRules.find(r => r.id === ruleId);
        if (r) {
          const rt = r.rule_type || 'admin';
          form = { ...form, ruleType: rt === 'direct' ? 'direct' : 'admin', _ruleTypeIndex: rt === 'direct' ? 1 : 0, _flowSteps: [] };
        } else {
          form = { ...form, ruleType: 'admin', _ruleTypeIndex: 0, _flowSteps: [] };
        }
      }
    }
    form._editingStepIdx = null;
    form._editingConditionIdx = null;
    form._editingStepName = '';
    form._editingStepRules = [];
    form._editingCondition = null;
    this.setData({
      ruleEditorVisible: true, ruleEditId: ruleId, ruleEditorType: type, ruleForm: form,
      ruleEditorScrollStyle: 'height:0px !important;',
      ruleEditorScrollIntoView: '',
      weeklyChecked: buildWeeklyChecked(form.cycleValues),
      monthlyChecked: buildMonthlyChecked(form.cycleValues)
    }, () => this._scheduleRuleEditorViewportSync());
    if (type === 'booking' && (!this.data.allDepartments.length || !this.data.allWorkGroups.length)) {
      this.loadFlowReferenceData();
    }
  },

  closeRuleEditor() {
    this._clearRuleEditorViewportTimer();
    this._clearRuleEditorRevealTimer();
    this.setData({
      ruleEditorVisible: false,
      ruleEditorScrollStyle: '',
      ruleEditorScrollIntoView: '',
      'ruleForm._editingStepIdx': null,
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingCondition': null
    });
  },

  _clearRuleEditorViewportTimer() {
    if (this._ruleEditorViewportTimer) {
      clearTimeout(this._ruleEditorViewportTimer);
      this._ruleEditorViewportTimer = null;
    }
  },

  _clearRuleEditorRevealTimer() {
    if (this._ruleEditorRevealTimer) {
      clearTimeout(this._ruleEditorRevealTimer);
      this._ruleEditorRevealTimer = null;
    }
  },

  _revealRuleEditorPart(target) {
    if (!target || !this.data.ruleEditorVisible) return;
    this._clearRuleEditorRevealTimer();
    this.setData({ ruleEditorScrollIntoView: '' }, () => {
      wx.nextTick(() => {
        this._ruleEditorRevealTimer = setTimeout(() => {
          this._ruleEditorRevealTimer = null;
          if (this.data.ruleEditorVisible) this.setData({ ruleEditorScrollIntoView: target });
        }, 60);
      });
    });
  },

  _scheduleRuleEditorViewportSync() {
    if (!this.data.ruleEditorVisible) return;
    this._clearRuleEditorViewportTimer();
    this._ruleEditorViewportTimer = setTimeout(() => {
      this._ruleEditorViewportTimer = null;
      wx.nextTick(() => this._syncRuleEditorViewport());
    }, 20);
  },

  _syncRuleEditorViewport() {
    if (!this.data.ruleEditorVisible) return;
    const query = wx.createSelectorQuery();
    query.select('.rule-editor-popup').boundingClientRect();
    query.select('.rule-editor-popup-header').boundingClientRect();
    query.select('.rule-editor-scroll').boundingClientRect();
    query.select('.rule-editor-stack').boundingClientRect();
    query.select('.rule-editor-popup-footer').boundingClientRect();
    query.select('.rule-editor-viewport-limit').boundingClientRect();
    query.exec((rects) => {
      const shell = rects[0];
      const header = rects[1];
      const body = rects[2];
      const content = rects[3];
      const footer = rects[4];
      const viewportLimit = rects[5];
      if (!shell || !header || !body || !content || !footer || !viewportLimit) return;

      const bodyStart = Math.max(0, body.top - shell.top);
      const footerHeight = Math.max(0, footer.height);
      const footerTail = Math.max(0, shell.bottom - footer.bottom);
      const maxShellHeight = Math.max(0, viewportLimit.height || shell.height);
      const maxBodyHeight = Math.max(1, Math.floor(maxShellHeight - bodyStart - footerHeight - footerTail));
      const contentHeight = Math.max(1, Math.ceil(content.height));
      const bodyHeight = Math.min(contentHeight, maxBodyHeight);
      const style = 'height:' + bodyHeight + 'px !important;';
      if (this.data.ruleEditorScrollStyle !== style) {
        this.setData({ ruleEditorScrollStyle: style });
      }
    });
  },

  onFieldInput(e) {
    const f = e.currentTarget.dataset.field;
    this.setData({ [f]: e.detail.value });
  },

  onRuleFormField(e) {
    const f = e.currentTarget.dataset.field;
    this.setData({ ['ruleForm.' + f]: e.detail.value }, () => this._scheduleRuleEditorViewportSync());
  },

  onBookingWindowMode(e) {
    const side = e.currentTarget.dataset.side;
    const modes = ['none', 'days', 'duration'];
    const mode = modes[Number(e.detail.value)] || 'none';
    this.setData({ ['ruleForm.bookingWindow.' + side + '.mode']: mode }, () => this._scheduleRuleEditorViewportSync());
  },

  onBookingWindowDays(e) {
    const side = e.currentTarget.dataset.side;
    this.setData({ ['ruleForm.bookingWindow.' + side + '.days']: e.detail.value }, () => this._scheduleRuleEditorViewportSync());
  },

  onBookingWindowHours(e) {
    const side = e.currentTarget.dataset.side;
    this.setData({ ['ruleForm.bookingWindow.' + side + '.hours']: Number(e.detail.value) || 0 }, () => this._scheduleRuleEditorViewportSync());
  },

  onBookingWindowMinutes(e) {
    const side = e.currentTarget.dataset.side;
    this.setData({ ['ruleForm.bookingWindow.' + side + '.minutes']: Number(e.detail.value) || 0 }, () => this._scheduleRuleEditorViewportSync());
  },

  onCycleTypeChange(e) {
    const isActivity = this.data.ruleEditorType === 'activity';
    const types = isActivity ? ['daily', 'weekly', 'monthly', 'yearly'] : ['daily', 'weekly', 'monthly', 'yearly', 'range'];
    const idx = parseInt(e.detail.value);
    const ct = types[idx] || 'weekly';
    let cycleValues = [];
    if (isActivity) cycleValues = emptyActivityCycleValues();
    else if (ct === 'range') cycleValues = { startDate: '', endDate: '' };
    this.setData({
      'ruleForm.cycleType': ct,
      'ruleForm._cycleTypeIndex': idx,
      'ruleForm.cycleValues': cycleValues,
      weeklyChecked: [false, false, false, false, false, false, false],
      monthlyChecked: Array(31).fill(false)
    }, () => this._scheduleRuleEditorViewportSync());
  },

  onBookingRuleTypeChange(e) {
    const idx = parseInt(e.detail.value);
    const types = ['admin', 'direct'];
    const rt = types[idx] || 'admin';
    const update = {
      'ruleForm.ruleType': rt,
      'ruleForm._ruleTypeIndex': idx,
      'ruleForm._editingStepIdx': null,
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingCondition': null
    };
    this.setData(update, () => this._scheduleRuleEditorViewportSync());
  },

  onBookingIdentityChange(e) {
    const idx = parseInt(e.detail.value);
    const ident = this.data.allIdentities[idx];
    if (ident) {
      this.setData({
        'ruleForm.approverIdentityId': ident.id,
        'ruleForm.approverIdentityName': ident.name,
        'ruleForm.approverIdentityIndex': idx
      });
    }
  },

  onBookingHrChange(e) {
    const idx = parseInt(e.detail.value);
    const hr = this.data.allHrPersons[idx];
    if (hr) {
      this.setData({
        'ruleForm.approverHrId': hr.id,
        'ruleForm.approverHrName': hr.name,
        'ruleForm.approverHrIndex': idx
      });
    }
  },

  // Toggle a weekly day
  onToggleWeekDay(e) {
    const idx = parseInt(e.currentTarget.dataset.idx); // 0-6
    const checked = [...this.data.weeklyChecked];
    checked[idx] = !checked[idx];
    // Rebuild cycleValues from checked array
    const vals = [];
    checked.forEach((c, i) => { if (c) vals.push(i + 1); });
    const currentValues = this.data.ruleForm.cycleValues;
    const nextValues = this.data.ruleEditorType === 'activity'
      ? { ...normalizeActivityCycleValues(this.data.ruleForm.cycleType, currentValues), values: vals }
      : vals;
    this.setData({
      weeklyChecked: checked,
      'ruleForm.cycleValues': nextValues
    });
  },

  // Toggle a monthly day
  onToggleMonthDay(e) {
    const idx = parseInt(e.currentTarget.dataset.idx); // 0-30
    const checked = [...this.data.monthlyChecked];
    checked[idx] = !checked[idx];
    const vals = [];
    checked.forEach((c, i) => { if (c) vals.push(i + 1); });
    const currentValues = this.data.ruleForm.cycleValues;
    const nextValues = this.data.ruleEditorType === 'activity'
      ? { ...normalizeActivityCycleValues(this.data.ruleForm.cycleType, currentValues), values: vals }
      : vals;
    this.setData({
      monthlyChecked: checked,
      'ruleForm.cycleValues': nextValues
    });
  },

  // Yearly range: month pickers
  onYearlyRangeStartMonthChange(e) {
    this.setData({ yearlyRangeStartMonth: parseInt(e.detail.value) + 1 });
  },
  onYearlyRangeStartDayChange(e) {
    this.setData({ yearlyRangeStartDay: parseInt(e.detail.value) + 1 });
  },
  onYearlyRangeEndMonthChange(e) {
    this.setData({ yearlyRangeEndMonth: parseInt(e.detail.value) + 1 });
  },
  onYearlyRangeEndDayChange(e) {
    this.setData({ yearlyRangeEndDay: parseInt(e.detail.value) + 1 });
  },

  // Add a date range to yearly cycle values
  onAddYearlyRange() {
    const sm = this.data.yearlyRangeStartMonth;
    const sd = this.data.yearlyRangeStartDay;
    const em = this.data.yearlyRangeEndMonth;
    const ed = this.data.yearlyRangeEndDay;
    // Validate: start must be before or equal to end
    if (sm > em || (sm === em && sd > ed)) {
      showShortToast(localeCopy.copy_2ea7993cca); return;
    }
    const currentValues = this.data.ruleForm.cycleValues;
    let vals = [...(Array.isArray(currentValues) ? currentValues : ((currentValues && currentValues.values) || []))];
    // Check for duplicate
    const dup = vals.some(v => v && Number(v.m) === sm && Number(v.dStart) === sd && Number(v.dEnd) === ed);
    if (!dup) {
      vals.push({ m: sm, dStart: sd, dEnd: ed });
      vals.sort((a, b) => (Number(a.m) - Number(b.m)) || (Number(a.dStart) - Number(b.dStart)));
      this.setData({ 'ruleForm.cycleValues': this.data.ruleEditorType === 'activity' ? { ...normalizeActivityCycleValues(this.data.ruleForm.cycleType, currentValues), values: vals } : vals });
    }
  },

  // Remove a yearly range by index
  onRemoveYearlyRange(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const currentValues = this.data.ruleForm.cycleValues;
    let vals = [...(Array.isArray(currentValues) ? currentValues : ((currentValues && currentValues.values) || []))];
    vals.splice(idx, 1);
    this.setData({ 'ruleForm.cycleValues': this.data.ruleEditorType === 'activity' ? { ...normalizeActivityCycleValues(this.data.ruleForm.cycleType, currentValues), values: vals } : vals });
  },

  // ── Range cycle type date handlers ──
  onRangeStartDateChange(e) {
    const d = e.detail.value;
    const cv = Object.assign({}, this.data.ruleForm.cycleValues || {});
    cv.startDate = d;
    this.setData({ 'ruleForm.cycleValues': cv });
  },

  onRangeEndDateChange(e) {
    const d = e.detail.value;
    const cv = Object.assign({}, this.data.ruleForm.cycleValues || {});
    cv.endDate = d;
    this.setData({ 'ruleForm.cycleValues': cv });
  },

  async saveRule() {
    const { ruleEditId, ruleEditorType, ruleForm, rulesVenueId } = this.data;
    let endpoint, data;
    if (ruleEditorType === 'booking') {
      const openMinutes = bookingWindowMinutes(ruleForm.bookingWindow && ruleForm.bookingWindow.open);
      const deadlineMinutes = bookingWindowMinutes(ruleForm.bookingWindow && ruleForm.bookingWindow.deadline);
      if (openMinutes !== null && deadlineMinutes !== null && openMinutes < deadlineMinutes) {
        showShortToast(localeCopy.copy_b1545efd70);
        return;
      }
    }
    if (ruleEditorType === 'open') {
      endpoint = 'saveVenueOpenRule';
      data = { id: ruleEditId, venueId: rulesVenueId, name: ruleForm.name, cycleType: ruleForm.cycleType, cycleValues: ruleForm.cycleValues, timeStart: ruleForm.timeStart, timeEnd: ruleForm.timeEnd };
    } else if (ruleEditorType === 'activity') {
      endpoint = 'saveVenueActivityRule';
      data = { id: ruleEditId, venueId: rulesVenueId, activityName: ruleForm.name, cycleType: ruleForm.cycleType, cycleValues: ruleForm.cycleValues, timeStart: ruleForm.timeStart, timeEnd: ruleForm.timeEnd };
    } else {
      // 'booking' type: admin / direct / flow
      if (ruleForm.ruleType === 'flow') {
        // Save the whole approval flow
        const stepsData = (ruleForm._flowSteps || []).map((s, i) => ({
          name: s.name || (localeCopy.copy_93c50c01c0 + (i + 1) + localeCopy.copy_493a127a99),
          sortOrder: i + 1,
          approvalMode: (s.rules || []).length ? 'hr_rule' : 'admin_any',
          rules: (s.rules || []).map(r => ({
            departmentScope: r.departmentScope || 'all',
            specificDepartmentId: r.specificDepartmentId || '',
            workGroupScope: r.workGroupScope || 'all',
            specificWorkGroupId: r.specificWorkGroupId || '',
            identityScope: r.identityScope || 'all',
            specificIdentityId: r.specificIdentityId || ''
          }))
        }));
        endpoint = 'saveVenueApprovalWholeFlow';
        data = {
          venueId: rulesVenueId,
          flowId: this.data.selectedFlowId || '',
          flowName: this.data.selectedFlowName || localeCopy.copy_890d7f4874,
          allowUserSelect: this.data.allowUserSelectFlow,
          allowDesignateFirst: this.data.allowDesignateFirstFlow,
          allowDesignateNext: this.data.allowDesignateNextFlow,
          steps: stepsData,
          bookingWindow: ruleForm.bookingWindow
        };
      } else {
        endpoint = 'saveVenueBookingRule';
        data = { id: ruleEditId, venueId: rulesVenueId, ruleType: ruleForm.ruleType || 'admin', bookingWindow: ruleForm.bookingWindow };
      }
    }
    const removesDirectRule = ruleEditorType === 'booking' && ruleForm.ruleType === 'flow'
      && (this.data.bookingRules || []).some(function(rule) { return rule.rule_type === 'direct'; });
    const removesFlows = ruleEditorType === 'booking' && ruleForm.ruleType === 'direct'
      && (this.data.approvalFlows || []).length > 0;
    if (removesDirectRule || removesFlows) {
      const confirmed = await new Promise(function(resolve) {
        wx.showModal({
          title: flowManagementCopy.switchTitle,
          content: removesDirectRule ? flowManagementCopy.directToFlow : flowManagementCopy.flowToDirect,
          success: function(result) { resolve(Boolean(result.confirm)); },
          fail: function() { resolve(false); }
        });
      });
      if (!confirmed) return;
    }
    try {
      const res = await callFunction({ name: endpoint, data });
      if (res.status === 'success') {
        showShortToast(res.message);
        this.setData({ ruleEditorVisible: false });
        await Promise.all([
          this.loadOpenRules(),
          this.loadActivityRules(),
          this.loadApprovalFlow()
        ]);
        await this.loadBookingRules();
      } else showShortToast(res.message);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_215e3c57da)); }
  },

  async deleteRule(e) {
    const type = e.currentTarget.dataset.type;
    const id = e.currentTarget.dataset.id;

    const ep = type === 'open' ? 'deleteVenueOpenRule' : (type === 'activity' ? 'deleteVenueActivityRule' : 'deleteVenueBookingRule');
    try {
      const res = await callFunction({ name: ep, data: { id } });
      if (res.status === 'success') {
        showShortToast(localeCopy.copy_5398fec054);
        this.loadOpenRules();
        this.loadActivityRules();
        this.loadBookingRules();
      } else showShortToast(res.message);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_076bb5d383)); }
  },

  // ── Cycle helpers ──
  getCycleLabel(type, values) {
    if (type === 'datetime_range' || type === 'repeat') return localeCopy.copy_13293d504a;
    if (type === 'daily') return localeCopy.copy_13293d504a;
    const v = typeof values === 'string' ? (() => { try { return JSON.parse(values); } catch (_) { return {}; } })() : (values || {});
    if (type === 'range') {
      if (v && v.startDate && v.endDate) return v.startDate + localeCopy.copy_c44dbba9e9 + v.endDate;
      return localeCopy.copy_9d73203530;
    }
    const arr = Array.isArray(v) ? v : ((v && Array.isArray(v.values)) ? v.values : []);
    const weekNames = ['', localeCopy.copy_92af9d9017, localeCopy.copy_e3233a4b58, localeCopy.copy_2f48862253, localeCopy.copy_017e3df1a1, localeCopy.copy_41a9548e60, localeCopy.copy_f2c74088c9, localeCopy.copy_a814b25100];
    if (type === 'weekly') return arr.map(i => weekNames[Number(i)] || i).join('、') || localeCopy.copy_2b4df49497;
    if (type === 'monthly') return localeCopy.copy_06a9527bac + arr.map(i => Number(i)).join('、') + localeCopy.copy_168587d3a1;
    if (type === 'yearly') return arr.map(c => {
      if (c.dEnd !== undefined) return (c.m || '?') + localeCopy.copy_438913e441 + (c.dStart || '?') + localeCopy.copy_05302eb150 + (c.dEnd || '?') + localeCopy.copy_168587d3a1;
      return (c.m || '?') + localeCopy.copy_438913e441 + (c.d || '?') + localeCopy.copy_168587d3a1;
    }).join('、');
    return JSON.stringify(arr);
  },

  viewActivityRuleDetail(e) {
    const id = e.currentTarget.dataset.id;
    const rule = (this.data.activityRules || []).find(item => item.id === id);
    if (!rule) return;
    this.setData({ activityDetailVisible: true, activityDetail: {
      name: rule.activity_name || localeCopy.copy_acd4c5c171,
      venueName: this.data.rulesVenueName,
      cycleLabel: rule._detailCycleLabel || rule._cycleLabel || '',
      legacyTime: (rule.time_start || '09:00').substring(0, 5) + localeCopy.copy_c44dbba9e9 + (rule.time_end || '18:00').substring(0, 5),
      note: rule.cycle_type === 'datetime_range' || rule.cycle_type === 'repeat' ? localeCopy.copy_ebe09ed8ec : localeCopy.copy_e90ee137d6
    }});
  },

  closeActivityDetail() { this.setData({ activityDetailVisible: false, activityDetail: null }); },

  getRuleTypeLabel(rt) {
    const map = { direct: localeCopy.copy_4f15bb9939, admin: localeCopy.copy_af20193574, identity: localeCopy.copy_fa045c9cde, person: localeCopy.copy_777a6a2574 };
    return map[rt] || rt;
  },

  // ── Bookings tab (borrow management, ported from venueBookings) ──

  async loadBookingsData() {
    const request = orgSession.beginRequest(this, 'manageBookings');
    this.setData({ bookingsLoading: true });
    try {
      const { filterStatus, filterVenueId, timeFrom, timeTo } = this.data;

      // Map computed statuses back to DB status for the API query
      const computedStatuses = ['inUse', 'completed'];
      const apiStatus = computedStatuses.includes(filterStatus) ? 'approved' : (filterStatus || undefined);

      // 1. Always fetch ALL pending bookings (regardless of time)
      const pendingReq = callFunction({
        name: 'listAllVenueBookings',
        data: { status: 'pending', venueId: filterVenueId || undefined }
      });

      // 2. Fetch bookings within time range with optional status filter
      const timeReq = callFunction({
        name: 'listAllVenueBookings',
        data: {
          status: apiStatus,
          venueId: filterVenueId || undefined,
          timeFrom: timeFrom ? timeFrom + ' 00:00' : undefined,
          timeTo: timeTo ? timeTo + ' 23:59' : undefined
        }
      });

      const [pendingRes, timeRes] = await Promise.all([pendingReq, timeReq]);
      if (!orgSession.isRequestCurrent(this, request)) return;

      // 非 success 状态提示错误
      if (pendingRes.status !== 'success' && pendingRes.status !== undefined)
        showShortToast(pendingRes.message || localeCopy.copy_e52119b17e);
      if (timeRes.status !== 'success' && timeRes.status !== undefined)
        showShortToast(timeRes.message || localeCopy.copy_e52119b17e);

      const pendingList = (pendingRes.status === 'success' ? pendingRes.bookings : []) || [];
      const timeList = (timeRes.status === 'success' ? timeRes.bookings : []) || [];

      // Merge: pending at top (deduped), then time-filtered non-pending
      const pendingIds = new Set(pendingList.map(b => b.id));
      const nonPending = timeList.filter(b => !pendingIds.has(b.id));
      let merged = [...pendingList, ...nonPending];

      // Compute display status and approval percent for each booking
      let bookings = merged.map(prepareVenueBookingDetail);

      // Client-side filter for computed statuses (inUse / completed)
      if (computedStatuses.includes(filterStatus)) {
        bookings = bookings.filter(b => b.displayStatus === filterStatus);
      }

      this.setData({ bookings });
    } catch (e) {
      if (orgSession.isRequestCurrent(this, request)) showShortToast(getErrorText(e, localeCopy.copy_e52119b17e));
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ bookingsLoading: false });
    }
  },

  onFilterStatus(e) {
    this.setData({ filterStatus: e.currentTarget.dataset.status });
    this.loadBookingsData();
  },
  onFilterVenue(e) {
    this.setData({ filterVenueId: e.currentTarget.dataset.id || '' });
    this.loadBookingsData();
  },

  onTimeFromChange(e) {
    this.setData({ timeFrom: e.detail.value, timeFromDisplay: e.detail.value });
    this.loadBookingsData();
  },
  onTimeToChange(e) {
    this.setData({ timeTo: e.detail.value, timeToDisplay: e.detail.value });
    this.loadBookingsData();
  },
  onClearTime() {
    const to = getSystemDate();
    const from = addDateDays(to, -7);
    this.setData({
      timeFrom: from,
      timeTo: to,
      timeFromDisplay: from,
      timeToDisplay: to
    });
    this.loadBookingsData();
  },

  // ── Step-aware approve/reject (with confirmation popup) ──

  openApprovePopup(e) {
    const id = e.currentTarget.dataset.id;
    const booking = this.data.bookings.find(b => b.id === id);
    if (!booking) return;
    this.setData({
      approvalPopupVisible: true,
      approvalPopupId: id,
      approvalPopupAction: 'approve',
      approvalPopupComment: '',
      approvalPopupTarget: booking
    });
  },

  openRejectPopup(e) {
    const id = e.currentTarget.dataset.id;
    const booking = this.data.bookings.find(b => b.id === id);
    if (!booking) return;
    this.setData({
      approvalPopupVisible: true,
      approvalPopupId: id,
      approvalPopupAction: 'reject',
      approvalPopupComment: '',
      approvalPopupTarget: booking
    });
  },

  closeApprovalPopup() {
    this.setData({
      approvalPopupVisible: false,
      approvalPopupId: '',
      approvalPopupAction: '',
      approvalPopupComment: '',
      expandedNodeKey: '',
      approvalPopupTarget: null
    });
  },

  onApprovalCommentInput(e) {
    this.setData({ approvalPopupComment: e.detail.value });
  },

  async submitApprovalAction() {
    const { approvalPopupId, approvalPopupAction, approvalPopupComment, approvalPopupTarget } = this.data;
    if (!approvalPopupId || !approvalPopupAction) return;

    const target = approvalPopupTarget
      || this.data.bookings.find(function(booking) { return booking.id === approvalPopupId; });
    if (!target) return;

    const endpoint = resolveVenueApprovalEndpoint(target, approvalPopupAction);
    const label = approvalPopupAction === 'approve' ? localeCopy.copy_ce171a2581 : localeCopy.copy_5d5af942c5;

    this.setData({ loading: true });
    try {
      const res = await callFunction({
        name: endpoint,
        data: { id: approvalPopupId, comment: approvalPopupComment }
      });
      if (res.status === 'success') {
        showShortToast(res.message || label);
        this.closeApprovalPopup();
        this.loadBookingsData();
        if (this.data.scheduleVisible) this.loadVenueTimetable();
        eventBus.emit('venue:changed', { reason: approvalPopupAction, bookingId: approvalPopupId });
        eventBus.emit('approval:done');
      } else {
        showShortToast(res.message);
      }
    } catch (e) {
      showShortToast(getErrorText(e, localeCopy.copy_0531ed9e78));
    } finally {
      this.setData({ loading: false });
    }
  },

  // ── Admin Timetable / Schedule ──
  _initWeekStart() {
    this.setData({ scheduleWeekStart: getSystemWeekStart() });
  },

  async openVenueSchedule(e) {
    const id = e.currentTarget.dataset.id;
    const v = this.data.venues.find(v => v.id === id);
    this.setData({ scheduleVisible: true, scheduleVenueId: id, scheduleVenueName: v ? v.name : '', timetableColumns: [] });
    await this.loadVenueTimetable();
  },
  closeVenueSchedule() { this.setData({ scheduleVisible: false, bookingDetailVisible: false, activityDetailVisible: false, activityDetail: null, expandedNodeKey: '' }); },

  onTimetableScroll(e) {
    _timetableScrollTop = e.detail.scrollTop || 0;
  },

  async loadVenueTimetable() {
    const request = orgSession.beginRequest(this, 'manageTimetable');
    const { scheduleVenueId, scheduleWeekStart } = this.data;
    const dateTo = addDateDays(scheduleWeekStart, 6);
    wx.showLoading({ title: localeCopy.copy_fc99c4cc7b });
    try {
      const res = await callFunction({
        name: 'getVenueSchedule',
        data: { venueId: scheduleVenueId, dateFrom: scheduleWeekStart, dateTo }
      });
      if (!orgSession.isRequestCurrent(this, request)) return;
      if (res.status === 'success') {
        this._buildAdminTimetable(res.dailySchedules || []);
      }
    } catch (e) {
      if (orgSession.isRequestCurrent(this, request)) showShortToast(getErrorText(e, localeCopy.copy_e52119b17e));
    } finally {
      if (orgSession.isRequestCurrent(this, request)) wx.hideLoading();
    }
  },

  _buildAdminTimetable(dailySchedules) {
    const weekDayLabels = [localeCopy.copy_92af9d9017,localeCopy.copy_e3233a4b58,localeCopy.copy_2f48862253,localeCopy.copy_017e3df1a1,localeCopy.copy_41a9548e60,localeCopy.copy_f2c74088c9,localeCopy.copy_a814b25100];
    const columns = [];
    for (let i = 0; i < 7; i++) {
      const dateStr = addDateDays(this.data.scheduleWeekStart, i);
      const dateDisplay = dateStr.slice(5).replace('-', '/');
      const dayData = dailySchedules.find(ds => ds.date === dateStr);
      const col = this._buildDayColumn(dayData, dateStr, weekDayLabels[i], dateDisplay);
      columns.push(col);
    }
    this.setData({ timetableColumns: columns });
  },

  _buildDayColumn(dayData, dateStr, label, dateDisplay) {
    const openBlocks = [];
    const eventBlocks = [];
    const timeTargets = [];

    if (dayData && dayData.openSlots) {
      for (const o of dayData.openSlots) {
        const { top, height } = calcBlock(o.timeStart, o.timeEnd);
        const s = timeToMin(o.timeStart);
        const e = timeToMin(o.timeEnd);
        openBlocks.push({ top: top + HEADER_H + TEXT_OFFSET, height, startMin: s, endMin: e, duration: e - s });
        // Generate time targets only within this open slot, at half-hour intervals
        for (let min = s; min < e; min += 30) {
          const hh = Math.floor(min / 60);
          const mm = min % 60;
          const offset_rpx = (min - s) / (e - s) * height;
          timeTargets.push({
            top: top + HEADER_H + TEXT_OFFSET + offset_rpx,
            time: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
          });
        }
      }
    }

    if (dayData && dayData.activitySlots) {
      for (const a of dayData.activitySlots) {
        const { top, height } = calcBlock(a.timeStart, a.timeEnd);
        eventBlocks.push({
          top: top + HEADER_H + TEXT_OFFSET,
          height,
          status: 'activity',
          label: a.ruleName || localeCopy.copy_acd4c5c171,
          type: 'activity',
          activity: a.activity || {
            id: a.ruleId,
            name: a.ruleName || localeCopy.copy_acd4c5c171,
            occurrenceStart: a.fullTimeStart || (dateStr + ' ' + a.timeStart),
            occurrenceEnd: a.fullTimeEnd || (dateStr + ' ' + a.timeEnd),
            cycleType: '',
            cycleValues: {}
          }
        });
      }
    }

    if (dayData && dayData.bookedSlots) {
      for (const b of dayData.bookedSlots) {
        const { top, height } = calcBlock(b.timeStart, b.timeEnd);
        eventBlocks.push({
          top: top + HEADER_H + TEXT_OFFSET, height,
          status: b.status === 'pending' ? 'pending' : 'booked',
          label: b.title || localeCopy.copy_8aa6e63e5e,
          type: 'booking',
          booking: {
            id: b.id, venueId: b.venueId, venueName: b.venueName || '', venueLocation: b.venueLocation || '',
            title: b.title, description: b.description,
            visibility: b.visibility || 'details',
            userId: b.userId, userName: b.userName,
            userDept: b.userDept || '', userIdentity: b.userIdentity || '', userWorkGroup: b.userWorkGroup || '',
            orgName: b.orgName || '',
            creatorType: b.creatorType, creatorName: b.creatorName, creatorLabel: b.creatorLabel,
            creatorAssignmentId: b.creatorAssignmentId || '', creatorAssignmentLabel: b.creatorAssignmentLabel || '',
            approverHrId: b.approverHrId, approvalComment: b.approvalComment || '', createdAt: b.createdAt,
            timeStart: b.fullTimeStart || b.timeStart,
            timeEnd: b.fullTimeEnd || b.timeEnd,
            timeStartDisplay: b.timeStart,
            timeEndDisplay: b.timeEnd,
            status: b.status,
            approvalProgress: b.approvalProgress || null
          }
        });
      }
    }

    return { date: dateStr, label, dateDisplay, openBlocks, eventBlocks, timeTargets };
  },

  onTimetablePrevWeek() {
    this.setData({ scheduleWeekStart: addDateDays(this.data.scheduleWeekStart, -7) });
    this.loadVenueTimetable();
  },
  onTimetableNextWeek() {
    this.setData({ scheduleWeekStart: addDateDays(this.data.scheduleWeekStart, 7) });
    this.loadVenueTimetable();
  },

  onTimetableBlockTap(e) {
    const block = e.currentTarget.dataset.block;
    if (block && block.activity) {
      this.viewActivityScheduleDetail(block.activity);
      return;
    }
    if (!block || !block.booking) return;
    if (block.booking.visibility === 'occupancy_only') {
      this.openOccupiedPopup(block.booking);
      return;
    }
    // 与借用记录列表一致的详情组装：状态与审批进度时间轴
    const detail = prepareVenueBookingDetail(block.booking);
    this.setData({ bookingDetailVisible: true, bookingDetail: detail, expandedNodeKey: '' });
  },

  onActivityCycleDateChange(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ ['ruleForm.cycleValues.' + field]: e.detail.value }, () => this._scheduleRuleEditorViewportSync());
  },

  onActivityCycleTimeChange(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ ['ruleForm.cycleValues.' + field]: e.detail.value }, () => this._scheduleRuleEditorViewportSync());
  },

  onActivityPeriodModeTap(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!['none', 'range', 'count'].includes(mode)) return;
    const currentMode = this.data.ruleForm.cycleValues.periodMode;
    this.setData({ 'ruleForm.cycleValues.periodMode': currentMode === mode ? 'none' : mode }, () => this._scheduleRuleEditorViewportSync());
  },

  onActivityRepeatField(e) {
    const field = e.currentTarget.dataset.field;
    const value = Math.max(0, Number(e.detail.value) || 0);
    if (!field) return;
    this.setData({ ['ruleForm.cycleValues.' + field]: value }, () => this._scheduleRuleEditorViewportSync());
  },
  openOccupiedPopup(booking) {
    const start = booking.timeStartDisplay || '';
    const end = booking.timeEndDisplay || '';
    const timeText = (start || end) ? ((start ? start + localeCopy.copy_c44dbba9e9 : '') + (end || '')) : '';
    this.setData({ occupiedPopupVisible: true, occupiedPopupTime: timeText });
  },
  closeOccupiedPopup() { this.setData({ occupiedPopupVisible: false, occupiedPopupTime: '' }); },

  onTimeTargetTap(e) {
    // Same pattern as date: data-date + data-time from DOM, no coordinate math
    const date = e.currentTarget.dataset.date;
    const time = e.currentTarget.dataset.time;
    if (!date || !time) return;
    this.setData({
      adminBookingVisible: true,
      adminBookingStartDate: date,
      adminBookingStartDateDisplay: date,
      adminBookingEndDate: date,
      adminBookingEndDateDisplay: date,
      adminBookingTimeStart: time,
      adminBookingTimeEnd: '',
      adminBookingTitle: '',
      adminBookingDesc: '',
      adminDailySlots: []
    });
    this._loadAdminAvailability(date, time);
  },

  onTimetableOpenTap(e) {
    const date = e.currentTarget.dataset.date;
    // e.detail.y is column-relative. Its unit varies by device — use it directly,
    // same as how data-date uses the raw string without conversion.
    // The time labels are spaced HOUR_HEIGHT apart; the header is ~HEADER_H.
    // Divide raw tapY by half-hour height, round, then back out hour:min.
    const halfH = HOUR_HEIGHT / 2;
    const rawIdx = Math.round((e.detail.y - HEADER_H) / halfH);
    const idx = Math.min(Math.max(rawIdx, 0), 47);
    const h = Math.floor(idx / 2);
    const m = (idx % 2) * 30;
    const time = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    this.setData({
      adminBookingVisible: true,
      adminBookingStartDate: date,
      adminBookingStartDateDisplay: date,
      adminBookingEndDate: date,
      adminBookingEndDateDisplay: date,
      adminBookingTimeStart: time,
      adminBookingTimeEnd: '',
      adminBookingTitle: '',
      adminBookingDesc: '',
      adminDailySlots: []
    });
    this._loadAdminAvailability(date, time);
  },

  closeBookingDetail() { this.setData({ bookingDetailVisible: false, expandedNodeKey: '' }); },

  viewActivityScheduleDetail(activity) {
    if (!activity) return;
    this.setData({ activityDetailVisible: true, activityDetail: {
      name: activity.name || localeCopy.copy_acd4c5c171,
      venueName: this.data.scheduleVenueName,
      cycleLabel: formatActivityCycleLabel(activity.cycleType, activity.cycleValues),
      occurrenceTime: (activity.occurrenceStart || '') + localeCopy.copy_c44dbba9e9 + (activity.occurrenceEnd || ''),
      note: localeCopy.copy_c1ce05d451
    }});
  },

  viewBookingDetail(e) {
    let id = e.currentTarget.dataset.id;
    let item = this.data.bookings.find(function(b) { return b.id === id; });
    if (!item) return;
    if (item.visibility === 'occupancy_only') {
      showShortToast(localeCopy.copy_d52606f8f8);
      return;
    }
    this.setData({ bookingDetailVisible: true, bookingDetail: item, expandedNodeKey: '' });
  },

  // ── Admin Quick Booking ──
  closeAdminBooking() { this.setData({ adminBookingVisible: false }); },

  onAdminStartDateChange(e) {
    const d = e.detail.value;
    this.setData({
      adminBookingStartDate: d, adminBookingStartDateDisplay: d,
      adminBookingEndDate: d, adminBookingEndDateDisplay: d,
      adminBookingTimeStart: '', adminBookingTimeEnd: '',
      adminStartHours: [], adminStartHourIdx: 0, adminStartMinIdx: 0,
      adminEndHours: [], adminEndHourIdx: 0, adminEndMinIdx: 0,
      _adminDayData: null
    });
    this._loadAdminAvailability(d);
  },

  async _loadAdminAvailability(dateStr, presetTime) {
    if (!dateStr) return;
    wx.showLoading({ title: localeCopy.copy_96eaa4c0be });
    try {
      const res = await callFunction({
        name: 'getVenueSchedule',
        data: { venueId: this.data.scheduleVenueId, dateFrom: dateStr, dateTo: dateStr }
      });
      if (res.status === 'success') {
        const dayData = (res.dailySchedules || [])[0];
        if (dayData) {
          const openSlots = dayData.openSlots || [];
          const openHourSet = new Set();
          for (const o of openSlots) {
            const os = timeToMin(o.timeStart);
            const oe = timeToMin(o.timeEnd);
            for (let h = Math.floor(os / 60); h < Math.ceil(oe / 60); h++) {
              if (h >= 0 && h < 24) openHourSet.add(h);
            }
          }
          const sortedHours = Array.from(openHourSet).sort((a, b) => a - b);
          const startHours = sortedHours.map(h => ({ value: h, label: String(h).padStart(2, '0') }));
          const endHoursAll = sortedHours.map(h => ({ value: h, label: String(h).padStart(2, '0') }));
          // Use presetTime (passed directly) or existing value
          const useTime = presetTime || this.data.adminBookingTimeStart || '';
          const parts = useTime.split(':');
          const useH = parseInt(parts[0]) || 0;
          const useM = parseInt(parts[1]) || 0;
          const sHi = Math.max(0, startHours.findIndex(h => h.value === useH));
          const sMi = Math.max(0, ALL_MINUTES.findIndex(m => m.value === useM));
          const setData = {
            adminStartHours: startHours, adminStartHourIdx: sHi, adminStartMinIdx: sMi,
            adminEndHours: endHoursAll, adminEndHourIdx: 0, adminEndMinIdx: 0,
            _adminDayData: dayData,
            adminTimelineBlocks: this._buildAdminTimeline(dayData)
          };
          if (presetTime) setData.adminBookingTimeStart = presetTime;
          this.setData(setData);
        } else {
          this.setData({
            adminStartHours: [], adminEndHours: [],
            _adminDayData: null
          });
        }
      } else {
        showShortToast(res.message || localeCopy.copy_e52119b17e);
      }
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_e52119b17e)); }
    finally { wx.hideLoading(); }
  },

  onAdminStartHourChange(e) {
    const idx = parseInt(e.detail.value);
    const hour = this.data.adminStartHours[idx] ? this.data.adminStartHours[idx].value : 0;
    const min = ALL_MINUTES[this.data.adminStartMinIdx] ? ALL_MINUTES[this.data.adminStartMinIdx].value : 0;
    this.setData({ adminStartHourIdx: idx, adminBookingTimeStart: String(hour).padStart(2,'0')+':'+String(min).padStart(2,'0') });
    this._adminRefreshEndHours();
    this._syncAdminTimelineSelection();
  },
  onAdminStartMinChange(e) {
    const idx = parseInt(e.detail.value);
    const min = ALL_MINUTES[idx] ? ALL_MINUTES[idx].value : 0;
    const hour = this.data.adminStartHours[this.data.adminStartHourIdx] ? this.data.adminStartHours[this.data.adminStartHourIdx].value : 0;
    this.setData({ adminStartMinIdx: idx, adminBookingTimeStart: String(hour).padStart(2,'0')+':'+String(min).padStart(2,'0') });
    this._adminRefreshEndHours();
    this._syncAdminTimelineSelection();
  },
  onAdminEndHourChange(e) {
    const idx = parseInt(e.detail.value);
    const hour = this.data.adminEndHours[idx] ? this.data.adminEndHours[idx].value : 0;
    const min = ALL_MINUTES[this.data.adminEndMinIdx] ? ALL_MINUTES[this.data.adminEndMinIdx].value : 0;
    this.setData({ adminEndHourIdx: idx, adminBookingTimeEnd: String(hour).padStart(2,'0')+':'+String(min).padStart(2,'0') });
    this._syncAdminTimelineSelection();
  },
  onAdminEndMinChange(e) {
    const idx = parseInt(e.detail.value);
    const min = ALL_MINUTES[idx] ? ALL_MINUTES[idx].value : 0;
    const hour = this.data.adminEndHours[this.data.adminEndHourIdx] ? this.data.adminEndHours[this.data.adminEndHourIdx].value : 0;
    this.setData({ adminEndMinIdx: idx, adminBookingTimeEnd: String(hour).padStart(2,'0')+':'+String(min).padStart(2,'0') });
    this._syncAdminTimelineSelection();
  },

  _buildAdminTimeline(dayData) {
    const blocks = [];
    const append = (slots, status) => (slots || []).forEach((slot) => {
      const start = timeToMin(slot.timeStart);
      const end = timeToMin(slot.timeEnd);
      if (end > start) blocks.push({ status, left: (start / 1440 * 100).toFixed(2), width: ((end - start) / 1440 * 100).toFixed(2) });
    });
    append(dayData.openSlots, 'free');
    append(dayData.bookedSlots, 'booked');
    append(dayData.activitySlots, 'activity');
    return blocks;
  },

  _syncAdminTimelineSelection() {
    const start = timeToMin(this.data.adminBookingTimeStart);
    const end = timeToMin(this.data.adminBookingTimeEnd);
    this.setData({
      adminTimelineSelection: start >= 0 && end > start
        ? { left: (start / 1440 * 100).toFixed(2), end: (end / 1440 * 100).toFixed(2), width: ((end - start) / 1440 * 100).toFixed(2) }
        : null
    });
  },

  onAdminTimelineStart(e) {
    const handle = e.currentTarget.dataset.handle;
    wx.createSelectorQuery().select('.admin-timeline-drag').boundingClientRect((rect) => {
      if (!rect) return;
      this._adminTimelineDrag = { handle, left: rect.left, width: rect.width };
      this.onAdminTimelineMove(e);
    }).exec();
  },

  onAdminTimelineMove(e) {
    const drag = this._adminTimelineDrag;
    const touch = e.touches && e.touches[0];
    if (!drag || !touch || !drag.width) return;
    const raw = Math.max(0, Math.min(1440, (touch.clientX - drag.left) / drag.width * 1440));
    const minute = Math.round(raw / 15) * 15;
    const value = minToTime(Math.min(minute, 1439));
    const update = drag.handle === 'start' ? { adminBookingTimeStart: value } : { adminBookingTimeEnd: value };
    this.setData(update);
    this._syncAdminTimelineSelection();
  },

  onAdminTimelineEnd() {
    this._adminTimelineDrag = null;
    this._syncAdminTimelineSelection();
  },

  _adminRefreshEndHours() {
    const dayData = this.data._adminDayData;
    if (!dayData) return;
    const openSlots = dayData.openSlots || [];
    const startMin = timeToMin(this.data.adminBookingTimeStart);
    const endHourSet = new Set();
    for (const o of openSlots) {
      const os = timeToMin(o.timeStart);
      const oe = timeToMin(o.timeEnd);
      for (let h = Math.floor(Math.max(os, startMin + 1) / 60); h < Math.ceil(oe / 60); h++) {
        if (h >= 0 && h < 24) endHourSet.add(h);
      }
      if (oe > startMin && Math.floor(oe / 60) < 24) endHourSet.add(Math.floor(oe / 60));
    }
    const sortedHours = Array.from(endHourSet).sort((a, b) => a - b);
    const endHours = sortedHours.map(h => ({ value: h, label: String(h).padStart(2, '0') }));
    let endHourIdx = 0;
    const curEndHour = this.data.adminEndHours[this.data.adminEndHourIdx];
    if (curEndHour && endHourSet.has(curEndHour.value)) {
      endHourIdx = endHours.findIndex(h => h.value === curEndHour.value);
      if (endHourIdx < 0) endHourIdx = 0;
    }
    const eh = endHours[endHourIdx] ? endHours[endHourIdx].value : 0;
    const em = ALL_MINUTES[this.data.adminEndMinIdx] ? ALL_MINUTES[this.data.adminEndMinIdx].value : 0;
    this.setData({ adminEndHours: endHours, adminEndHourIdx: endHourIdx, adminBookingTimeEnd: String(eh).padStart(2,'0')+':'+String(em).padStart(2,'0') });
  },

  onAdminSelectPurpose(e) {
    const text = e.currentTarget.dataset.text;
    this.setData({ adminBookingTitle: text });
  },

  onAdminFieldInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async submitAdminBooking() {
    const { scheduleVenueId, adminBookingStartDate, adminBookingTitle, adminBookingTimeStart, adminBookingTimeEnd, adminBookingDesc, _adminDayData } = this.data;
    if (!scheduleVenueId || !adminBookingStartDate || !adminBookingTimeStart || !adminBookingTimeEnd) {
      showShortToast(localeCopy.copy_9dc5c7d79f); return;
    }
    if (!adminBookingTitle) { showShortToast(localeCopy.copy_7db68605c6); return; }
    const timeStart = adminBookingStartDate + 'T' + adminBookingTimeStart;
    const timeEnd = adminBookingStartDate + 'T' + adminBookingTimeEnd;
    if (timeStart >= timeEnd) { showShortToast(localeCopy.copy_0b091cba77); return; }

    // Validate range with interval merging
    if (_adminDayData) {
      const rangeStart = timeToMin(adminBookingTimeStart);
      const rangeEnd = timeToMin(adminBookingTimeEnd);
      const mergedOpen = mergeIntervals(slotsToIntervals(_adminDayData.openSlots || []));
      const gap = findOpenGap(rangeStart, rangeEnd, mergedOpen);
      if (gap >= 0) {
        const h = String(Math.floor(gap / 60)).padStart(2, '0');
        const mi = String(gap % 60).padStart(2, '0');
        showShortToast(h + ':' + mi + localeCopy.copy_70d4911767); return;
      }
      const mergedBlocked = mergeIntervals([
        ...slotsToIntervals(_adminDayData.bookedSlots || []),
        ...slotsToIntervals(_adminDayData.activitySlots || [])
      ]);
      const conflict = findBlockedOverlap(rangeStart, rangeEnd, mergedBlocked);
      if (conflict) {
        const h = String(Math.floor(conflict.start / 60)).padStart(2, '0');
        const mi = String(conflict.start % 60).padStart(2, '0');
        showShortToast(h + ':' + mi + localeCopy.copy_abf766aebc); return;
      }
    }

    this.setData({ loading: true });
    try {
      const res = await callFunction({
        name: 'createAdminVenueBooking',
        data: { venueId: scheduleVenueId, title: adminBookingTitle, description: adminBookingDesc,
                timeStart, timeEnd }
      });
      if (res.status === 'success') {
        showShortToast(res.message);
        this.setData({ adminBookingVisible: false });
        if (this.data.scheduleVisible) this.loadVenueTimetable();
      } else showShortToast(res.message);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_ccd4af477f)); }
    finally { this.setData({ loading: false }); }
  },

  // ── Purpose Management ──
  openPurposeManager() {
    // Switch to purposes tab instead of opening popup
    this.setData({ activeTab: 'purposes', purposeEditId: '', purposeEditText: '' });
    this.loadPurposes();
  },
  closePurposeManager() { this.setData({ purposeVisible: false }); },

  async loadPurposes() {
    const request = orgSession.beginRequest(this, 'managePurposes');
    try {
      const res = await callFunction({ name: 'listVenueBookingPurposes', data: {} });
      if (!orgSession.isRequestCurrent(this, request)) return;
      if (res.status === 'success') this.setData({ purposes: res.purposes || [] });
    } catch (_) {}
  },

  onPurposeFieldInput(e) {
    this.setData({ purposeEditText: e.detail.value });
  },

  startEditPurpose(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.purposes.find(p => p.id === id);
    if (p) this.setData({ purposeEditId: p.id, purposeEditText: p.text });
  },

  cancelPurposeEdit() {
    this.setData({ purposeEditId: '', purposeEditText: '' });
  },

  async savePurpose() {
    const { purposeEditId, purposeEditText } = this.data;
    const normalizedText = String(purposeEditText || '').trim();
    if (!normalizedText) { showShortToast(localeCopy.copy_fdb45fb38f); return; }
    if (unicodeLength(normalizedText) > BOOKING_PURPOSE_MAX_LENGTH) {
      showShortToast(localeCopy.bookingPurposeTooLong);
      return;
    }
    try {
      const res = await callFunction({
        name: 'saveVenueBookingPurpose',
        data: { id: purposeEditId, text: normalizedText }
      });
      if (res.status === 'success') {
        showShortToast(res.message);
        this.setData({ purposeEditId: '', purposeEditText: '' });
        this.loadPurposes();
      } else showShortToast(res.message);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_215e3c57da)); }
  },

  deletePurpose(e) {
    const id = e.currentTarget.dataset.id;
    const purpose = (this.data.purposes || []).find((item) => String(item.id || '') === String(id || ''));
    if (!purpose) return;
    const target = Object.freeze({ id: String(purpose.id || ''), text: String(purpose.text || '') });
    const that = this;
    wx.showModal({
      title: localeCopy.copy_7f31eec657,
      content: localeCopy.bookingPurposeDeletePrefix + target.text + localeCopy.bookingPurposeDeleteSuffix,
      confirmText: localeCopy.copy_acc985cabc,
      cancelText: localeCopy.copy_06dbb49961,
      success: function(modalResult) {
        if (!modalResult.confirm) return;
        that._deletePurposeTarget(target);
      }
    });
  },

  async _deletePurposeTarget(target) {
    if (!target || !target.id) return;
    try {
      const res = await callFunction({ name: 'deleteVenueBookingPurpose', data: { id: target.id } });
      if (res.status === 'success') { showShortToast(localeCopy.copy_5398fec054); this.loadPurposes(); }
      else showShortToast(res.message);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_076bb5d383)); }
  },

  // ═══════════════ APPROVAL FLOW MANAGEMENT (inline in rule editor) ═══════════════

  async loadApprovalFlow() {
    const venueId = this.data.rulesVenueId;
    if (!venueId) return;
    const request = orgSession.beginRequest(this, 'manageApprovalFlow');
    try {
      const res = await callFunction({ name: 'listVenueApprovalFlows', data: { venueId } });
      if (!orgSession.isRequestCurrent(this, request) || this.data.rulesVenueId !== venueId) return;
      if (res.status === 'success') {
        const flows = res.flows || [];
        let selected = this.data.selectedFlowId
          ? flows.find(function(flow) { return flow.id === this.data.selectedFlowId; }.bind(this))
          : flows[0];
        if (!selected && flows.length) selected = flows[0];
        const patch = { approvalFlows: flows, approvalFlow: selected || null };
        if (selected) {
          patch.selectedFlowId = selected.id;
          patch.selectedFlowName = selected.name || '';
          patch.approvalFlowSteps = selected.steps || [];
          patch.allowUserSelectFlow = Number(selected.allow_user_select) === 1;
          patch.allowDesignateFirstFlow = Number(selected.allow_designate_first) === 1;
          patch.allowDesignateNextFlow = Number(selected.allow_designate_next) === 1;
        } else {
          patch.selectedFlowId = '';
          patch.selectedFlowName = '';
          patch.approvalFlowSteps = [];
          patch.allowUserSelectFlow = false;
          patch.allowDesignateFirstFlow = false;
          patch.allowDesignateNextFlow = false;
        }
        this.setData(patch);
        if (!this.data.allDepartments.length || !this.data.allWorkGroups.length) {
          this.loadFlowReferenceData();
        }
      }
    } catch (_) {}
  },

  addApprovalFlow() {
    this._openApprovalFlowEditor({
      id: '',
      name: localeCopy.copy_9835b165c7,
      allow_user_select: 0,
      allow_designate_first: 0,
      allow_designate_next: 0,
      steps: []
    });
  },

  onBookingWindowSettingMode(e) {
    const side = e.currentTarget.dataset.side;
    const modeIndex = Number(e.detail.value);
    const mode = modeIndex === 1 ? 'days' : (modeIndex === 2 ? 'duration' : 'none');
    if (side !== 'open' && side !== 'deadline') return;
    this.setData({ ['bookingWindowForm.' + side + '.mode']: mode });
  },

  onBookingWindowSettingDays(e) {
    const side = e.currentTarget.dataset.side;
    if (side !== 'open' && side !== 'deadline') return;
    this.setData({ ['bookingWindowForm.' + side + '.days']: e.detail.value });
  },

  onBookingWindowSettingHours(e) {
    const side = e.currentTarget.dataset.side;
    if (side !== 'open' && side !== 'deadline') return;
    this.setData({ ['bookingWindowForm.' + side + '.hours']: Number(e.detail.value) || 0 });
  },

  onBookingWindowSettingMinutes(e) {
    const side = e.currentTarget.dataset.side;
    if (side !== 'open' && side !== 'deadline') return;
    this.setData({ ['bookingWindowForm.' + side + '.minutes']: Number(e.detail.value) || 0 });
  },

  async saveBookingWindowSettings() {
    const windowForm = this.data.bookingWindowForm || emptyBookingWindow();
    const openMinutes = bookingWindowMinutes(windowForm.open);
    const deadlineMinutes = bookingWindowMinutes(windowForm.deadline);
    if (openMinutes !== null && deadlineMinutes !== null && openMinutes < deadlineMinutes) {
      showShortToast(localeCopy.copy_b1545efd70);
      return;
    }
    try {
      const res = await callFunction({
        name: 'saveVenueBookingWindow',
        data: { venueId: this.data.rulesVenueId, bookingWindow: windowForm }
      });
      if (res.status === 'success') {
        showShortToast(res.message || localeCopy.copy_26f68cb229);
        await this.loadBookingRules();
      } else showShortToast(res.message || localeCopy.copy_215e3c57da);
    } catch (e) { showShortToast(getErrorText(e, localeCopy.copy_215e3c57da)); }
  },

  async toggleApprovalFlowFlag(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const field = String(e.currentTarget.dataset.field || '');
    const value = Boolean(e.detail.value);
    const flow = (this.data.approvalFlows || []).find(function(item) { return item.id === id; });
    const supportedFields = ['allow_user_select', 'allow_designate_first', 'allow_designate_next'];
    if (!flow || supportedFields.indexOf(field) < 0) return;
    const allowUserSelect = field === 'allow_user_select'
      ? value
      : Number(flow.allow_user_select) === 1;
    const allowDesignateFirst = field === 'allow_designate_first'
      ? value
      : Number(flow.allow_designate_first) === 1;
    const allowDesignateNext = field === 'allow_designate_next'
      ? value
      : Number(flow.allow_designate_next) === 1;
    try {
      const res = await callFunction({
        name: 'saveVenueApprovalFlowMeta',
        data: {
          venueId: this.data.rulesVenueId,
          flowId: id,
          name: flow.name || localeCopy.copy_890d7f4874,
          allowUserSelect,
          allowDesignateFirst,
          allowDesignateNext
        }
      });
      if (res.status === 'success') {
        const flows = (this.data.approvalFlows || []).map(function(item) {
          if (item.id !== id) return item;
          const next = Object.assign({}, item);
          next[field] = value ? 1 : 0;
          return next;
        });
        const patch = { approvalFlows: flows };
        if (id === this.data.selectedFlowId) {
          if (field === 'allow_designate_first') patch.allowDesignateFirstFlow = value;
          if (field === 'allow_designate_next') patch.allowDesignateNextFlow = value;
          if (field === 'allow_user_select') patch.allowUserSelectFlow = value;
        }
        this.setData(patch);
      } else showShortToast(res.message || localeCopy.copy_bff49f783f);
    } catch (err) { showShortToast(getErrorText(err, localeCopy.copy_bff49f783f)); }
  },

  deleteApprovalFlow(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const flow = (this.data.approvalFlows || []).find(function(item) { return item.id === id; });
    if (!flow) return;
    wx.showModal({
      title: localeCopy.copy_7f31eec657,
      content: localeCopy.copy_19aa0fdb46,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await callFunction({ name: 'deleteVenueApprovalFlow', data: { flowId: id, venueId: this.data.rulesVenueId } });
          if (res.status === 'success') {
            showShortToast(localeCopy.copy_5398fec054);
            this.setData({ selectedFlowId: '' });
            await this.loadApprovalFlow();
          } else showShortToast(res.message || localeCopy.copy_bff49f783f);
        } catch (err) { showShortToast(getErrorText(err, localeCopy.copy_bff49f783f)); }
      }
    });
  },

  openApprovalFlowStepEditor(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const flow = (this.data.approvalFlows || []).find(function(item) { return item.id === id; });
    if (!flow) return;
    this._openApprovalFlowEditor(flow);
  },

  _openApprovalFlowEditor(flow) {
    const steps = (flow.steps || []).map(function(s) {
      return {
        name: s.name || '',
        approvalMode: s.approval_mode || ((s.rules || []).length ? 'hr_rule' : 'admin_any'),
        rules: (s.rules || []).map(function(r) {
          return {
            departmentScope: r.department_scope || 'all', specificDepartmentId: r.specific_department_id || '',
            workGroupScope: r.work_group_scope || 'all', specificWorkGroupId: r.specific_work_group_id || '',
            identityScope: r.identity_scope || 'all', specificIdentityId: r.specific_identity_id || ''
          };
        })
      };
    });
    this.setData({
      selectedFlowId: flow.id,
      selectedFlowName: flow.name || '',
      approvalFlowSteps: flow.steps || [],
      allowUserSelectFlow: Number(flow.allow_user_select) === 1,
      allowDesignateFirstFlow: Number(flow.allow_designate_first) === 1,
      allowDesignateNextFlow: Number(flow.allow_designate_next) === 1,
      ruleEditorVisible: true,
      ruleEditId: flow.id || '',
      ruleEditorType: 'booking',
      ruleForm: {
        name: '', cycleType: 'weekly', cycleValues: [], timeStart: '09:00', timeEnd: '18:00', bookingWindow: bookingWindowFromRow(this.data.bookingWindow),
        ruleType: 'flow', approverIdentityId: '', approverHrId: '',
        approverIdentityName: '', approverHrName: '', approverIdentityIndex: 0, approverHrIndex: 0,
        _flowSteps: this._decorateFlowSteps(steps),
        _editingStepIdx: null,
        _editingConditionIdx: null,
        _editingStepName: '',
        _editingStepRules: [],
        _editingCondition: null
      },
      ruleEditorScrollStyle: 'height:0px !important;',
      ruleEditorScrollIntoView: '',
      weeklyChecked: [],
      monthlyChecked: []
    }, () => this._scheduleRuleEditorViewportSync());
    if (!this.data.allDepartments.length || !this.data.allWorkGroups.length) {
      this.loadFlowReferenceData();
    }
  },

  async loadFlowReferenceData() {
    const request = orgSession.beginRequest(this, 'manageFlowReferences');
    try {
      const [deptRes, wgRes] = await Promise.all([
        callFunction({ name: 'listDepartments', data: {} }),
        callFunction({ name: 'listWorkGroups', data: {} })
      ]);
      if (!orgSession.isRequestCurrent(this, request)) return;
      this.setData({
        allDepartments: (deptRes.status === 'success' ? deptRes.departments : []) || [],
        allWorkGroups: (wgRes.status === 'success' ? wgRes.workGroups : []) || []
      }, () => this._refreshRuleEditorRuleLabels());
    } catch (_) {}
  },

  // ── Step CRUD within ruleForm._flowSteps ──

  openAddRuleFlowStep() {
    this.setData({
      'ruleForm._editingStepIdx': -1,
      'ruleForm._editingStepName': '',
      'ruleForm._editingStepRules': [],
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingCondition': null
    }, () => {
      this._scheduleRuleEditorViewportSync();
      this._revealRuleEditorPart('rule-flow-step-editor');
    });
  },

  editRuleFlowStep(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const steps = this.data.ruleForm._flowSteps || [];
    const step = steps[idx];
    if (!step) return;
    this.setData({
      'ruleForm._editingStepIdx': idx,
      'ruleForm._editingStepName': step.name || '',
      'ruleForm._editingStepRules': (step.rules || []).map(r => this._decorateRuleDisplay(r)),
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingCondition': null
    }, () => {
      this._scheduleRuleEditorViewportSync();
      this._revealRuleEditorPart('rule-flow-step-editor');
    });
  },

  removeRuleFlowStep(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const steps = [...(this.data.ruleForm._flowSteps || [])];
    steps.splice(idx, 1);
    this.setData({ 'ruleForm._flowSteps': steps });
  },

  moveRuleFlowStepUp(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    if (idx <= 0) return;
    const steps = [...(this.data.ruleForm._flowSteps || [])];
    [steps[idx - 1], steps[idx]] = [steps[idx], steps[idx - 1]];
    this.setData({ 'ruleForm._flowSteps': steps });
  },

  moveRuleFlowStepDown(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const steps = this.data.ruleForm._flowSteps || [];
    if (idx >= steps.length - 1) return;
    const s = [...steps];
    [s[idx], s[idx + 1]] = [s[idx + 1], s[idx]];
    this.setData({ 'ruleForm._flowSteps': s });
  },

  saveRuleFlowStep() {
    const name = (this.data.ruleForm._editingStepName || '').trim();
    if (!name) { showShortToast(localeCopy.copy_1376e7cf03); return; }
    const steps = [...(this.data.ruleForm._flowSteps || [])];
    const stepData = {
      name,
      approvalMode: (this.data.ruleForm._editingStepRules || []).length ? 'hr_rule' : 'admin_any',
      rules: (this.data.ruleForm._editingStepRules || []).map(r => this._decorateRuleDisplay({
        departmentScope: r.departmentScope || 'all',
        specificDepartmentId: r.specificDepartmentId || '',
        workGroupScope: r.workGroupScope || 'all',
        specificWorkGroupId: r.specificWorkGroupId || '',
        identityScope: r.identityScope || 'all',
        specificIdentityId: r.specificIdentityId || ''
      }))
    };
    const idx = this.data.ruleForm._editingStepIdx;
    if (idx >= 0 && idx < steps.length) {
      steps[idx] = { ...steps[idx], ...stepData };
    } else {
      steps.push(stepData);
    }
    this.setData({
      'ruleForm._flowSteps': steps,
      'ruleForm._editingStepIdx': null,
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingStepName': '',
      'ruleForm._editingStepRules': [],
      'ruleForm._editingCondition': null
    }, () => this._scheduleRuleEditorViewportSync());
  },

  cancelRuleFlowStepEdit() {
    this.setData({
      'ruleForm._editingStepIdx': null,
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingStepName': '',
      'ruleForm._editingStepRules': [],
      'ruleForm._editingCondition': null
    }, () => this._scheduleRuleEditorViewportSync());
  },

  onRuleFlowSubField(e) {
    const f = e.currentTarget.dataset.field;
    this.setData({ ['ruleForm.' + f]: e.detail.value }, () => this._scheduleRuleEditorViewportSync());
  },

  // ── Rule/Condition CRUD within a step ──

  openAddRuleFlowCondition() {
    const condition = this._decorateEditingCondition({
      deptScope: 'all', deptIds: [],
      wgScope: 'all', wgIds: [],
      identScope: 'all', identIds: []
    });
    this.setData({
      'ruleForm._editingConditionIdx': -1,
      'ruleForm._editingCondition': condition
    }, () => {
      this._scheduleRuleEditorViewportSync();
      this._revealRuleEditorPart('rule-flow-condition-editor');
    });
  },

  editRuleFlowCondition(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const rules = this.data.ruleForm._editingStepRules || [];
    const rule = rules[idx];
    if (!rule) return;
    const deptIds = parseCsvArray(rule.specificDepartmentId);
    const wgIds = parseCsvArray(rule.specificWorkGroupId);
    const identIds = parseCsvArray(rule.specificIdentityId);
    const condition = this._decorateEditingCondition({
      deptScope: rule.departmentScope || 'all',
      deptIds,
      wgScope: rule.workGroupScope || 'all',
      wgIds,
      identScope: rule.identityScope || 'all',
      identIds
    });
    this.setData({
      'ruleForm._editingConditionIdx': idx,
      'ruleForm._editingCondition': condition
    }, () => {
      this._scheduleRuleEditorViewportSync();
      this._revealRuleEditorPart('rule-flow-condition-editor');
    });
  },

  removeRuleFlowCondition(e) {
    const idx = parseInt(e.currentTarget.dataset.idx);
    const rules = [...(this.data.ruleForm._editingStepRules || [])];
    rules.splice(idx, 1);
    this.setData({ 'ruleForm._editingStepRules': rules });
  },

  saveRuleFlowCondition() {
    const cond = this.data.ruleForm._editingCondition;
    if (!cond) return;
    const rules = [...(this.data.ruleForm._editingStepRules || [])];
    const ruleData = {
      departmentScope: cond.deptScope || 'all',
      specificDepartmentId: (cond.deptScope === 'specific' && cond.deptIds) ? cond.deptIds.join(',') : '',
      workGroupScope: cond.wgScope || 'all',
      specificWorkGroupId: (cond.wgScope === 'specific' && cond.wgIds) ? cond.wgIds.join(',') : '',
      identityScope: cond.identScope || 'all',
      specificIdentityId: (cond.identScope === 'specific' && cond.identIds) ? cond.identIds.join(',') : ''
    };
    const displayRule = this._decorateRuleDisplay(ruleData);
    const idx = this.data.ruleForm._editingConditionIdx;
    if (idx >= 0 && idx < rules.length) {
      rules[idx] = { ...rules[idx], ...displayRule };
    } else {
      rules.push(displayRule);
    }
    this.setData({
      'ruleForm._editingStepRules': rules,
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingCondition': null
    }, () => this._scheduleRuleEditorViewportSync());
  },

  cancelRuleFlowCondEdit() {
    this.setData({
      'ruleForm._editingConditionIdx': null,
      'ruleForm._editingCondition': null
    }, () => this._scheduleRuleEditorViewportSync());
  },

  // ── Condition picker handlers ──

  onCondDeptScope(e) {
    const scopes = ['all', 'same', 'specific'];
    const v = scopes[parseInt(e.detail.value)] || 'all';
    const condition = this._decorateEditingCondition({
      ...(this.data.ruleForm._editingCondition || {}),
      deptScope: v,
      deptIds: []
    });
    this.setData({ 'ruleForm._editingCondition': condition }, () => this._scheduleRuleEditorViewportSync());
  },
  onCondWgScope(e) {
    const scopes = ['all', 'same', 'specific'];
    const v = scopes[parseInt(e.detail.value)] || 'all';
    const condition = this._decorateEditingCondition({
      ...(this.data.ruleForm._editingCondition || {}),
      wgScope: v,
      wgIds: []
    });
    this.setData({ 'ruleForm._editingCondition': condition }, () => this._scheduleRuleEditorViewportSync());
  },
  onCondIdentScope(e) {
    const scopes = ['all', 'same', 'specific'];
    const v = scopes[parseInt(e.detail.value)] || 'all';
    const condition = this._decorateEditingCondition({
      ...(this.data.ruleForm._editingCondition || {}),
      identScope: v,
      identIds: []
    });
    this.setData({ 'ruleForm._editingCondition': condition }, () => this._scheduleRuleEditorViewportSync());
  },

  // ── Condition Multi-Picker (replicates audit multi-picker pattern) ──

  openCondMultiPicker(e) {
    const target = e.currentTarget.dataset.target; // 'dept' | 'wg' | 'ident'
    let title, items, idField, nameField, selectedIdsArray;
    if (target === 'dept') {
      title = localeCopy.copy_6ee8d85d0a; items = this.data.allDepartments; idField = 'id'; nameField = 'name';
      selectedIdsArray = this.data.ruleForm._editingCondition.deptIds || [];
    } else if (target === 'wg') {
      title = localeCopy.copy_eed7859498; items = this.data.allWorkGroups; idField = 'id'; nameField = 'name';
      selectedIdsArray = this.data.ruleForm._editingCondition.wgIds || [];
    } else {
      title = localeCopy.copy_43c26e4c16; items = this.data.allIdentities; idField = 'id'; nameField = 'name';
      selectedIdsArray = this.data.ruleForm._editingCondition.identIds || [];
    }

    const selectedIds = {};
    selectedIdsArray.forEach(id => { selectedIds[String(id)] = true; });

    // Build items with deptId for work group target
    let mappedItems;
    if (target === 'wg') {
      mappedItems = items.map(it => ({
        id: it[idField] || it.id,
        name: it[nameField] || it.name,
        extra: it.departmentName || '',
        deptId: it.departmentId || ''
      }));
    } else {
      mappedItems = items.map(it => ({ id: it[idField] || it.id, name: it[nameField] || it.name, extra: '' }));
    }

    // Build department tabs if specific departments are selected
    let deptTabs = [];
    let activeDeptTab = '';
    const cond = this.data.ruleForm._editingCondition || {};
    if (target === 'wg' && cond.deptScope === 'specific' && cond.deptIds && cond.deptIds.length) {
      const selectedDeptIds = cond.deptIds.map(function(s) { return String(s).trim(); }).filter(Boolean);
      const deptMap = {};
      mappedItems.forEach(function(wg) {
        if (selectedDeptIds.indexOf(wg.deptId) >= 0) {
          if (!deptMap[wg.deptId]) deptMap[wg.deptId] = { deptId: wg.deptId, deptName: wg.extra || localeCopy.copy_de00c3e48a, workGroups: [], selectedCount: 0 };
          deptMap[wg.deptId].workGroups.push(wg);
        }
      });
      deptTabs = selectedDeptIds.map(function(did) {
        return deptMap[did] || { deptId: did, deptName: localeCopy.copy_de00c3e48a, workGroups: [], selectedCount: 0 };
      });
      // Initialize per-tab selected counts
      deptTabs = deptTabs.map(function(tab) {
        let count = tab.workGroups.filter(function(wg) { return selectedIds[String(wg.id)]; }).length;
        return Object.assign({}, tab, { selectedCount: count });
      });
      if (deptTabs.length) activeDeptTab = deptTabs[0].deptId;
    }

    this.setData({
      condMultiPickerVisible: true,
      condMultiPickerTarget: target,
      condMultiPickerTitle: title,
      condMultiPickerItems: mappedItems,
      condMultiPickerSelectedIds: selectedIds,
      condMultiPickerSelectedCount: selectedIdsArray.length,
      condMultiPickerSearch: '',
      condMultiPickerDeptTabs: deptTabs,
      condMultiPickerActiveDeptTab: activeDeptTab
    });
    this._applyCondMultiPickerFilters();
  },

  closeCondMultiPicker() { this.setData({ condMultiPickerVisible: false }); },

  onCondMultiPickerDeptTab(e) {
    this.setData({ condMultiPickerActiveDeptTab: e.currentTarget.dataset.dept });
    this._applyCondMultiPickerFilters();
  },

  onCondMultiPickerSearch(e) {
    this.setData({ condMultiPickerSearch: e.detail.value });
    this._applyCondMultiPickerFilters();
  },

  onCondMultiPickerToggle(e) {
    const id = String(e.currentTarget.dataset.id);
    const selected = { ...this.data.condMultiPickerSelectedIds };
    if (selected[id]) { delete selected[id]; } else { selected[id] = true; }

    // Update per-tab selected counts
    let deptTabs = this.data.condMultiPickerDeptTabs;
    if (deptTabs.length) {
      deptTabs = deptTabs.map(tab => ({
        ...tab,
        selectedCount: tab.workGroups.filter(wg => selected[String(wg.id)]).length
      }));
    }

    this.setData({
      condMultiPickerSelectedIds: selected,
      condMultiPickerSelectedCount: Object.keys(selected).length,
      condMultiPickerDeptTabs: deptTabs
    });
  },

  onCondMultiPickerSelectAll() {
    const selected = { ...this.data.condMultiPickerSelectedIds };
    this.data.condMultiPickerFilteredList.forEach(item => { selected[String(item.id)] = true; });

    // Update per-tab selected counts
    let deptTabs = this.data.condMultiPickerDeptTabs;
    if (deptTabs.length) {
      deptTabs = deptTabs.map(tab => ({
        ...tab,
        selectedCount: tab.workGroups.filter(wg => selected[String(wg.id)]).length
      }));
    }

    this.setData({
      condMultiPickerSelectedIds: selected,
      condMultiPickerSelectedCount: Object.keys(selected).length,
      condMultiPickerDeptTabs: deptTabs
    });
  },

  onCondMultiPickerDeselectAll() {
    // When dept tabs active, only deselect current tab
    let deptTabs = this.data.condMultiPickerDeptTabs;
    let selected = { ...this.data.condMultiPickerSelectedIds };
    if (deptTabs.length) {
      const activeTab = this.data.condMultiPickerActiveDeptTab;
      deptTabs.forEach(tab => {
        if (tab.deptId === activeTab) {
          tab.workGroups.forEach(wg => { delete selected[String(wg.id)]; });
        }
      });
      deptTabs = deptTabs.map(tab => ({
        ...tab,
        selectedCount: tab.workGroups.filter(wg => selected[String(wg.id)]).length
      }));
    } else {
      selected = {};
    }
    this.setData({
      condMultiPickerSelectedIds: selected,
      condMultiPickerSelectedCount: Object.keys(selected).length,
      condMultiPickerDeptTabs: deptTabs
    });
  },

  _applyCondMultiPickerFilters() {
    const keyword = (this.data.condMultiPickerSearch || '').trim().toLowerCase();
    let filtered = this.data.condMultiPickerItems || [];

    // Department tab filter for work group picker
    if (this.data.condMultiPickerTarget === 'wg' && this.data.condMultiPickerDeptTabs.length) {
      const activeTab = this.data.condMultiPickerActiveDeptTab;
      filtered = filtered.filter(item => item.deptId === activeTab);
    }

    if (keyword) {
      filtered = filtered.filter(item => (item.name || '').toLowerCase().indexOf(keyword) >= 0);
    }
    this.setData({ condMultiPickerFilteredList: filtered });
  },

  confirmCondMultiPicker() {
    const target = this.data.condMultiPickerTarget;
    const selected = this.data.condMultiPickerSelectedIds || {};
    const ids = Object.keys(selected);
    const currentCondition = this.data.ruleForm._editingCondition || {};
    if (target === 'dept') {
      this.setData({
        'ruleForm._editingCondition': this._decorateEditingCondition({
          ...currentCondition,
          deptIds: ids
        }),
        condMultiPickerVisible: false
      }, () => this._scheduleRuleEditorViewportSync());
    } else if (target === 'wg') {
      // Per-department validation when department tabs are active
      if (this.data.condMultiPickerDeptTabs.length) {
        for (const tab of this.data.condMultiPickerDeptTabs) {
          if (!tab.workGroups.length) continue;
          const hasSelection = tab.workGroups.some(wg => selected[String(wg.id)]);
          if (!hasSelection) {
            wx.showToast({ title: localeCopy.copy_c9c991ff82 + (tab.deptName || tab.deptId) + localeCopy.copy_eed7859498, icon: 'none' });
            return;
          }
        }
      }
      this.setData({
        'ruleForm._editingCondition': this._decorateEditingCondition({
          ...currentCondition,
          wgIds: ids
        }),
        condMultiPickerVisible: false
      }, () => this._scheduleRuleEditorViewportSync());
    } else {
      this.setData({
        'ruleForm._editingCondition': this._decorateEditingCondition({
          ...currentCondition,
          identIds: ids
        }),
        condMultiPickerVisible: false
      }, () => this._scheduleRuleEditorViewportSync());
    }
  },

  onCondFieldClear(e) {
    const field = e.currentTarget.dataset.field;
    const currentCondition = this.data.ruleForm._editingCondition || {};
    if (field === 'dept') {
      this.setData({
        'ruleForm._editingCondition': this._decorateEditingCondition({ ...currentCondition, deptIds: [] })
      }, () => this._scheduleRuleEditorViewportSync());
    } else if (field === 'wg') {
      this.setData({
        'ruleForm._editingCondition': this._decorateEditingCondition({ ...currentCondition, wgIds: [] })
      }, () => this._scheduleRuleEditorViewportSync());
    } else {
      this.setData({
        'ruleForm._editingCondition': this._decorateEditingCondition({ ...currentCondition, identIds: [] })
      }, () => this._scheduleRuleEditorViewportSync());
    }
  },

  // ── Expandable flow ──
  toggleFlowNode(e) {
    let key = e.currentTarget.dataset.nodeKey;
    this.setData({ expandedNodeKey: this.data.expandedNodeKey === key ? '' : key });
  },

  noop() {}
});
