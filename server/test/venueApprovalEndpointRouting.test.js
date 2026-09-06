const assert = require('assert');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function loadVenuePage(relativePath) {
  const calls = [];
  const events = [];
  let pageDefinition = null;
  const originalLoad = Module._load;
  const originalPage = global.Page;

  const apiStub = {
    async callFunction(options) {
      calls.push(options);
      if (options.name === 'approveVenueBookingStep') {
        return {
          status: 'success',
          approvalProgress: { currentStep: 1, totalSteps: 2, isApproved: false }
        };
      }
      return { status: 'success' };
    },
    getErrorText(error, fallback) {
      return fallback || String(error && error.message || '');
    },
    showShortToast() {}
  };

  Module._load = function(request, parent, isMain) {
    if (request.endsWith('/utils/api')) return apiStub;
    if (request.endsWith('/utils/flowTimeline')) {
      return { buildFlowTimeline: function() { return []; } };
    }
    if (request.endsWith('/utils/eventBus')) {
      return {
        emit(name, payload) { events.push({ name, payload }); },
        on() {},
        off() {}
      };
    }
    if (request.endsWith('/utils/orgSession')) {
      return {
        beginRequest() { return {}; },
        isRequestCurrent() { return true; },
        consume() { return { changed: false }; },
        invalidateRequests() {}
      };
    }
    if (request.endsWith('/utils/adminPermissions')) return {};
    if (request.endsWith('/utils/venueRuleDisplay')) {
      return { buildBookingRuleDisplayList: function() { return []; } };
    }
    if (request.endsWith('/utils/trustedNavigation')) {
      return { navigateToTrustedRoute() {} };
    }
    if (request.endsWith('/utils/venueBookingDetail')) {
      return {
        computeDisplayStatus(item) { return item && item.status || ''; },
        prepareVenueBookingDetail(item) { return item || {}; }
      };
    }
    if (request.endsWith('/utils/dateTime')) {
      return {
        getSystemDate() { return '2026-08-30'; },
        getSystemMinuteOfDay() { return 0; },
        getSystemWeekStart() { return '2026-08-24'; },
        addDateDays(value) { return value; },
        formatSystemClock() { return '20:00'; },
        systemDateTimeToTimestamp() { return Date.now() + 3600000; }
      };
    }
    if (request.endsWith('/utils/workContextPresentation')) {
      return {
        decoratePendingBooking(item) { return item || {}; },
        decorateApproverCandidates(items) { return items || []; },
        activeUserHasAssignment() { return true; },
        showWorkContextModal() {}
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  global.Page = function(definition) {
    pageDefinition = definition;
  };

  const absolutePath = path.resolve(ROOT, relativePath);
  delete require.cache[require.resolve(absolutePath)];
  try {
    require(absolutePath);
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }

  assert.ok(pageDefinition, relativePath + ' 必须注册 Page');
  return { pageDefinition, calls, events };
}

function createPageContext(definition, data, overrides) {
  const context = Object.assign({}, definition, overrides || {});
  context.data = Object.assign({}, definition.data || {}, data || {});
  context.setData = function(patch) {
    Object.assign(context.data, patch || {});
  };
  return context;
}

async function assertPendingPageRoute(pagePath, methodName, target, action, expectedEndpoint) {
  const loaded = loadVenuePage(pagePath);
  const context = createPageContext(loaded.pageDefinition, {
    pending: [target],
    approvalTarget: target,
    approvalAction: action,
    approvalComment: '测试意见',
    approvalSubmitting: false,
    nextApproverAssignmentIds: [],
    lastPendingCount: 1,
    lastPendingSignature: ''
  }, {
    _guardApprovalContext() { return true; },
    _scheduleApprovalSync() {},
    _formatTime() { return '20:00'; }
  });

  await context[methodName]();

  const approvalCalls = loaded.calls.filter(function(call) { return call.name === expectedEndpoint; });
  assert.strictEqual(approvalCalls.length, 1, pagePath + ' 应只提交一次审批请求');
  assert.strictEqual(approvalCalls[0].name, expectedEndpoint, pagePath + ' 应按记录类型选择接口');
  assert.strictEqual(approvalCalls[0].data.id, target.id);
  assert.ok(loaded.calls.some(function(call) { return call.name === 'listPendingVenueApprovals'; }),
    pagePath + ' 审批成功后必须重新读取权威待办');
  assert.strictEqual(context.data.approvalSubmitting, false, pagePath + ' 完成后必须复位提交状态');
}

async function assertManagePageRoute(target, action, expectedEndpoint) {
  const loaded = loadVenuePage('miniprogram/subpackages/venue/pages/venueManage/venueManage.js');
  const context = createPageContext(loaded.pageDefinition, {
    bookings: [target],
    approvalPopupId: target.id,
    approvalPopupAction: action,
    approvalPopupComment: '测试意见',
    approvalPopupTarget: target,
    loading: false,
    scheduleVisible: false
  }, {
    loadBookingsData() {},
    loadVenueTimetable() {}
  });

  await context.submitApprovalAction();

  assert.strictEqual(loaded.calls.length, 1, '管理端应只提交一次审批请求');
  assert.strictEqual(loaded.calls[0].name, expectedEndpoint, '管理端应按记录类型选择接口');
  assert.strictEqual(loaded.calls[0].data.id, target.id);
  assert.strictEqual(context.data.loading, false, '管理端完成后必须复位 loading');
}

async function assertIndependentFlowDrafts() {
  const loaded = loadVenuePage('miniprogram/subpackages/venue/pages/venueManage/venueManage.js');
  const context = createPageContext(loaded.pageDefinition, {
    rulesVenueId: 'venue-1',
    bookingRules: [],
    approvalFlows: [
      { id: 'flow-1', name: '流程一', steps: [{ name: '一审', rules: [] }] },
      { id: 'flow-2', name: '流程二', steps: [{ name: '二审', rules: [] }, { name: '三审', rules: [] }] }
    ],
    bookingWindow: null
  }, {
    _scheduleRuleEditorViewportSync() {},
    loadFlowReferenceData() {},
    loadOpenRules() {},
    loadActivityRules() {},
    loadApprovalFlow() {},
    loadBookingRules() {}
  });

  context.addApprovalFlow();
  assert.strictEqual(context.data.selectedFlowId, '', '新增流程必须使用空 ID 草稿');
  assert.deepStrictEqual(context.data.ruleForm._flowSteps, [], '新增流程不得继承已有步骤');
  assert.strictEqual(context.data.allowUserSelectFlow, false);
  assert.strictEqual(context.data.allowDesignateFirstFlow, false);
  assert.strictEqual(context.data.allowDesignateNextFlow, false);

  context.openApprovalFlowStepEditor({ currentTarget: { dataset: { id: 'flow-2' } } });
  assert.strictEqual(context.data.selectedFlowId, 'flow-2', '编辑必须携带当前卡片真实 flowId');
  assert.strictEqual(context.data.ruleForm._flowSteps.length, 2, '编辑不同流程不得串用第一条流程步骤');

  await context.saveRule();
  const saveCall = loaded.calls.find(function(call) { return call.name === 'saveVenueApprovalWholeFlow'; });
  assert.ok(saveCall, '流程编辑必须使用整流原子保存接口');
  assert.strictEqual(saveCall.data.flowId, 'flow-2', '保存时必须精确提交当前编辑流程 ID');
}

async function run() {
  const originalWx = global.wx;
  global.wx = {
    setNavigationBarTitle() {},
    getStorageSync() { return ''; },
    stopPullDownRefresh() {},
    showLoading() {},
    hideLoading() {}
  };

  try {
    const flatFlow = {
      id: 'flow-flat',
      approvalFlowId: 'flow-1',
      approvalCurrentStep: 0,
      approvalTotalSteps: 2
    };
    const flatLegacy = {
      id: 'legacy-flat',
      approvalFlowId: '',
      approvalCurrentStep: null,
      approvalTotalSteps: 0
    };
    const flatWithoutStepMarker = {
      id: 'legacy-flat-with-summary',
      approvalFlowId: 'flow-without-step',
      approvalCurrentStep: null,
      approvalTotalSteps: 2,
      flowSummary: [{ active: true }]
    };
    const nestedFlow = {
      id: 'flow-nested',
      approvalProgress: { flowId: 'flow-2', currentStep: 0, totalSteps: 2 }
    };
    const nestedLegacy = { id: 'legacy-nested', approvalProgress: null };
    const nestedWithoutFlowMarker = {
      id: 'legacy-nested-with-total',
      approvalProgress: { flowId: '', currentStep: 0, totalSteps: 2 }
    };

    const pendingPages = [
      ['miniprogram/subpackages/venue/pages/pendingVenueApprovals/pendingVenueApprovals.js', 'submitApproval'],
      ['miniprogram/subpackages/venue/pages/venueBooking/venueBooking.js', 'submitApproval']
    ];
    for (const [pagePath, methodName] of pendingPages) {
      await assertPendingPageRoute(pagePath, methodName, flatFlow, 'approve', 'approveVenueBookingStep');
      await assertPendingPageRoute(pagePath, methodName, flatFlow, 'reject', 'rejectVenueBookingStep');
      await assertPendingPageRoute(pagePath, methodName, flatLegacy, 'approve', 'approveVenueBooking');
      await assertPendingPageRoute(pagePath, methodName, flatLegacy, 'reject', 'rejectVenueBooking');
      await assertPendingPageRoute(pagePath, methodName, flatWithoutStepMarker, 'approve', 'approveVenueBooking');
    }

    await assertManagePageRoute(nestedFlow, 'approve', 'approveVenueBookingStep');
    await assertManagePageRoute(nestedFlow, 'reject', 'rejectVenueBookingStep');
    await assertManagePageRoute(nestedLegacy, 'approve', 'approveVenueBooking');
    await assertManagePageRoute(nestedLegacy, 'reject', 'rejectVenueBooking');
    await assertManagePageRoute(nestedWithoutFlowMarker, 'approve', 'approveVenueBooking');
    await assertIndependentFlowDrafts();

    console.log('场地历史非流程与流程审批分流测试通过');
  } finally {
    global.wx = originalWx;
  }
}

run().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
