const { callFunction, formatAuditTime, showShortToast } = require('../../../../utils/api');
const eventBus = require('../../../../utils/eventBus');
const orgSession = require('../../../../utils/orgSession');
const adminPermissions = require('../../../../utils/adminPermissions');
const authContext = require('../../../../utils/authContext');
const passwordBindingOffer = require('../../../../utils/passwordBindingOffer');
const { shouldClearAuthenticationOnPortalExit } = require('../../../../utils/portalExit');
const { activateOrganization } = require('../../../../utils/organizationActivation');
const notificationReceipt = require('../../../../utils/notificationNavigationReceipt');
const {
  isTrustedRoute,
  navigateToTrustedRoute,
  reLaunchPortalThenNavigate
} = require('../../../../utils/trustedNavigation');
const { portal: copy } = require('../../../../locales/zh-CN/main');
const NOTIFICATION_DELETE_WIDTH_PX = 72;
const CATEGORY_LABELS = {
  audit: copy.categoryLabels.audit,
  venue: copy.categoryLabels.venue,
  scoring: copy.categoryLabels.scoring,
  hr: copy.categoryLabels.hr,
  system: copy.categoryLabels.system
};

function isPartialBulkResult(result) {
  return !!(result && (
    result.partial
    || (Array.isArray(result.failedOrganizations) && result.failedOrganizations.length)
    || (Array.isArray(result.failures) && result.failures.length)
  ));
}

const PORTAL_CARDS_USER = [
  { key: 'messages', label: copy.cards.messages, iconName: 'bell', url: '/subpackages/message/pages/messageCenter/messageCenter', disabled: false },
  { key: 'identitySwitch', label: copy.cards.workContextSwitch, iconName: 'user', url: '/subpackages/org/pages/identitySwitch/identitySwitch', disabled: false },
  { key: 'scoring', label: copy.cards.scoring, iconName: 'grid', url: '/subpackages/workspace/pages/home/home?subApp=scoring', disabled: false },
  { key: 'hr', label: copy.cards.hr, iconName: 'user', url: '/subpackages/workspace/pages/home/home?subApp=hr', disabled: false },
  { key: 'audit', label: copy.cards.audit, iconName: 'file', url: '/subpackages/workspace/pages/home/home?subApp=audit', disabled: false },
  { key: 'venue', label: copy.cards.venueBooking, iconName: 'venue', url: '/subpackages/venue/pages/venueBooking/venueBooking', disabled: false }
];

const PORTAL_CARDS_ADMIN = [
  { key: 'messages', label: copy.cards.messages, iconName: 'bell', url: '/subpackages/message/pages/messageCenter/messageCenter', disabled: false },
  { key: 'identitySwitch', label: copy.cards.workContextSwitch, iconName: 'user', url: '/subpackages/org/pages/identitySwitch/identitySwitch', disabled: false },
  { key: 'scoring', label: copy.cards.scoring, iconName: 'grid', url: '/subpackages/scoring/pages/admin/admin?subApp=scoring', disabled: false },
  { key: 'hr', label: copy.cards.hr, iconName: 'user', url: '/subpackages/scoring/pages/admin/admin?subApp=hr', disabled: false },
  { key: 'system', label: copy.cards.system, iconName: 'shield', url: '/subpackages/scoring/pages/admin/admin?subApp=system', disabled: false },
  { key: 'audit', label: copy.cards.audit, iconName: 'file', url: '/subpackages/scoring/pages/admin/admin?subApp=audit', disabled: false },
  { key: 'venue', label: copy.cards.venueManage, iconName: 'venue', url: '/subpackages/venue/pages/venueManage/venueManage', disabled: false },
  { key: 'permissions', label: copy.cards.permissions, iconName: 'shield', url: '/subpackages/org/pages/adminPermissions/adminPermissions', disabled: false }
];

function getDisplayWorkContext(user, activeRole) {
  if (!user) return copy.workContext.signedOut;
  if (activeRole === 'admin') {
    return user.adminLevel === 'super_admin' ? copy.workContext.superAdmin : copy.workContext.admin;
  }
  return user.assignmentLabel || user.identity || copy.workContext.unset;
}

Page({
  data: {
    copy: copy.view,
    portalCards: [],
    heroName: '',
    heroWorkContext: '',
    heroInitial: '',
    userDepartment: '',
    userWorkGroup: '',
    hasUser: false,
    isAdminRole: false,
    activeRole: '',
    organizationName: '',
    todoCount: 0,
    todos: [],
    todoLoading: false,
    notificationCount: 0,
    notifications: [],
    notificationLoading: false,
    todoNextCursor: '',
    notificationNextCursor: '',
    todoLoadingMore: false,
    notificationLoadingMore: false,
    messagePartial: false,
    showMessageSwitchDialog: false,
    messageSwitchOrganizationName: '',
    messageSwitchTitle: copy.messages.switchOrganizationAndWorkContext,
    messageSwitchLoading: false,

    // 应用服务视图与搜索
    appViewMode: 'grid',        // 宫格或列表
    appSearchKeyword: '',
    filteredPortalCards: []
  },

  _pollTimer: null,
  _isPageVisible: true,
  _messageOverviewLoading: false,
  _messageOverviewQueued: false,

  onLoad(options) {
    wx.setNavigationBarTitle({ title: copy.navigationTitle });
    let pendingRoute = String((options && options.next) || '').trim();
    try { pendingRoute = decodeURIComponent(pendingRoute); } catch (_) { pendingRoute = ''; }
    this._pendingTrustedRoute = isTrustedRoute(pendingRoute)
      && pendingRoute.indexOf('/subpackages/main/pages/portal/portal') !== 0
      && pendingRoute.indexOf('/subpackages/main/pages/login/login') !== 0
      ? pendingRoute
      : '';
  },

  onShow() {
    this._isPageVisible = true;
    const activeSession = orgSession.getSnapshot();
    if (!activeSession.token || !activeSession.role) {
      authContext.clearUnifiedAuthentication();
      wx.reLaunch({ url: '/subpackages/main/pages/login/login' });
      return;
    }
    const organizationState = orgSession.consume(this);
    if (organizationState.changed) {
      orgSession.invalidateRequests(this);
      this._messageRevision = (this._messageRevision || 0) + 1;
      this.setData({
        organizationName: activeSession.orgName || '',
        todoCount: 0,
        todos: [],
        notificationCount: 0,
        notifications: [],
        todoNextCursor: '',
        notificationNextCursor: '',
        todoLoading: false,
        notificationLoading: false,
        messagePartial: false,
        appSearchKeyword: ''
      });
    }
    // 恢复已保存的视图偏好
    const savedView = wx.getStorageSync('appViewMode');
    if (savedView && (savedView === 'grid' || savedView === 'list')) {
      this.setData({ appViewMode: savedView });
    }
    const currentUserState = this.refreshCurrentUser();
    if (!currentUserState.hasUser) this.restoreCurrentUser(activeSession);
    if (currentUserState.isAdminRole) this.refreshAdminPermissionState();
    this.loadOrganizationName();
    if (currentUserState.hasUser) {
      this.retryPendingNotificationReads();
      this.loadMessageOverview();
    }
    this.startPolling();
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && typeof app.refreshTimeConfig === 'function') {
      if (this._timeConfigRefreshTimer) clearTimeout(this._timeConfigRefreshTimer);
      this._timeConfigRefreshTimer = setTimeout(function() { app.refreshTimeConfig(false); }, 500);
    }
    if (!this._boundOnApprovalDone) {
      this._boundOnApprovalDone = this._onApprovalDone.bind(this);
      eventBus.on('approval:done', this._boundOnApprovalDone);
    }
    if (!this._boundOnVenueChanged) {
      this._boundOnVenueChanged = this._onApprovalDone.bind(this);
      eventBus.on('venue:changed', this._boundOnVenueChanged);
    }
    if (!this._boundOnOrgChanged) {
      this._boundOnOrgChanged = this._onOrgChanged.bind(this);
      eventBus.on('org:changed', this._boundOnOrgChanged);
    }
    this.openPendingTrustedRoute();
    passwordBindingOffer.start(this);
  },

  openPendingTrustedRoute() {
    const targetUrl = this._pendingTrustedRoute;
    if (!targetUrl) return;
    this._pendingTrustedRoute = '';
    const receipt = notificationReceipt.take(targetUrl, orgSession.getSnapshot());
    navigateToTrustedRoute(targetUrl, {
      success: () => {
        if (receipt) this.confirmNotificationOpened(receipt);
      }
    });
  },

  onHide() {
    this._isPageVisible = false;
    passwordBindingOffer.cancel(this);
    if (this._timeConfigRefreshTimer) {
      clearTimeout(this._timeConfigRefreshTimer);
      this._timeConfigRefreshTimer = null;
    }
    this.stopPolling();
    if (this._boundOnApprovalDone) {
      eventBus.off('approval:done', this._boundOnApprovalDone);
      this._boundOnApprovalDone = null;
    }
    if (this._boundOnVenueChanged) {
      eventBus.off('venue:changed', this._boundOnVenueChanged);
      this._boundOnVenueChanged = null;
    }
    if (this._boundOnOrgChanged) {
      eventBus.off('org:changed', this._boundOnOrgChanged);
      this._boundOnOrgChanged = null;
    }
  },

  onUnload() {
    this._isPageVisible = false;
    passwordBindingOffer.cancel(this);
    const returningToLogin = shouldClearAuthenticationOnPortalExit(getCurrentPages(), this);
    this.stopPolling();
    if (this._timeConfigRefreshTimer) {
      clearTimeout(this._timeConfigRefreshTimer);
      this._timeConfigRefreshTimer = null;
    }
    if (this._boundOnApprovalDone) {
      eventBus.off('approval:done', this._boundOnApprovalDone);
      this._boundOnApprovalDone = null;
    }
    if (this._boundOnVenueChanged) {
      eventBus.off('venue:changed', this._boundOnVenueChanged);
      this._boundOnVenueChanged = null;
    }
    if (this._boundOnOrgChanged) {
      eventBus.off('org:changed', this._boundOnOrgChanged);
      this._boundOnOrgChanged = null;
    }
    if (returningToLogin) authContext.clearUnifiedAuthentication();
    if (returningToLogin) wx.reLaunch({ url: '/subpackages/main/pages/login/login' });
  },

  refreshCurrentUser() {
    const activeSession = orgSession.getSnapshot();
    const activeRole = activeSession.role || '';
    const user = activeRole ? authContext.getRuntimeProfile(activeRole) : null;
    const isAdminRole = activeRole === 'admin';
    const portalCards = isAdminRole ? adminPermissions.filterPortalCards(PORTAL_CARDS_ADMIN, user) : PORTAL_CARDS_USER;

    this.setData({
      activeRole,
      user: user,
      hasUser: !!user,
      isAdminRole: isAdminRole,
      heroName: user ? (user.name || copy.workContext.welcome) : copy.workContext.welcome,
      heroWorkContext: user ? getDisplayWorkContext(user, activeRole) : copy.appName,
      heroInitial: user && user.name ? user.name.charAt(0) : 'R',
      userDepartment: user ? (user.department || '') : '',
      userWorkGroup: user ? (user.workGroup || '') : '',
      portalCards: portalCards
    });
    this._applyAppFilter(portalCards);
    return { user, activeRole, isAdminRole, hasUser: !!user, portalCards };
  },

  async restoreCurrentUser(expectedSession) {
    try {
      await authContext.refreshCatalog();
      if (!orgSession.isCurrent(expectedSession)) return;
      const restored = this.refreshCurrentUser();
      if (restored.isAdminRole) await this.refreshAdminPermissionState();
      if (restored.hasUser) {
        this.retryPendingNotificationReads();
        this.loadMessageOverview();
      }
    } catch (error) {
      if (orgSession.isCurrent(expectedSession)) {
        console.error('[portal] restore current user failed:', error.message || error);
      }
    }
  },

  async refreshAdminPermissionState() {
    const request = orgSession.beginRequest(this, 'portalAdminPermissions');
    try {
      await adminPermissions.refreshMyPermissions();
      if (orgSession.isRequestCurrent(this, request)) this.refreshCurrentUser();
    } catch (error) {
      if (orgSession.isRequestCurrent(this, request)) console.error('[portal] refresh permissions failed:', error.message || error);
    }
  },

  loadOrganizationName() {
    const request = orgSession.beginRequest(this, 'portalOrganization');
    // 优先读取用户选择的活跃组织，其次回退 API 获取系统默认组织
    const storedName = orgSession.getSnapshot().orgName || '';
    if (storedName) {
      this.setData({ organizationName: storedName });
      return;
    }
    callFunction({
      name: 'getCurrentOrganization',
      success: (res) => {
        if (!orgSession.isRequestCurrent(this, request)) return;
        const result = res.result || {};
        const org = result.organization;
        const name = org && org.name ? org.name : '';
        this.setData({ organizationName: name });
        if (name) wx.setStorageSync('activeOrgName', name);
      },
      fail: () => {
        if (!orgSession.isRequestCurrent(this, request)) return;
        this.setData({ organizationName: '' });
      }
    });
  },

  onOrgTap() {
    navigateToTrustedRoute('/subpackages/org/pages/identitySwitch/identitySwitch');
  },

  onIdentityTap() {
    navigateToTrustedRoute('/subpackages/org/pages/identitySwitch/identitySwitch');
  },

  _onOrgChanged() {
    this.onShow();
  },

  onCardTap(e) {
    const key = e.currentTarget.dataset.key;
    const source = this.data.filteredPortalCards.length ? this.data.filteredPortalCards : this.data.portalCards;
    const card = source.find(function(c) { return c.key === key; });
    if (!card) return;
    if (card.disabled) {
      wx.showToast({ title: card.disabledReason || copy.messages.retryLater, icon: 'none' });
      return;
    }
    navigateToTrustedRoute(card.url);
  },

  // ── 应用服务视图与搜索 ──

  switchAppView(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.appViewMode) return;
    wx.setStorageSync('appViewMode', mode);
    this.setData({ appViewMode: mode });
  },

  onAppSearchInput(e) {
    this.setData({ appSearchKeyword: e.detail.value });
    this._applyAppFilter();
  },

  clearAppSearch() {
    this.setData({ appSearchKeyword: '' });
    this._applyAppFilter();
  },

  _applyAppFilter(sourceCards) {
    const keyword = (this.data.appSearchKeyword || '').trim().toLowerCase();
    const cards = Array.isArray(sourceCards) ? sourceCards : (this.data.portalCards || []);
    if (!keyword) {
      this.setData({ filteredPortalCards: cards });
      return;
    }
    const filtered = cards.filter(function(c) {
      const label = (c.label || '').toLowerCase();
      return label.indexOf(keyword) >= 0;
    });
    this.setData({ filteredPortalCards: filtered });
  },

  // ── 统一消息中心 ──
  formatMessageItems(items, isNotification) {
    return (items || []).map(function(item) {
      const extra = {
        categoryLabel: CATEGORY_LABELS[item.category] || (isNotification ? copy.messages.notification : copy.messages.todo),
        createdAtText: formatAuditTime(item.createdAt, item.createdAtReviewStatus),
        workContextName: item.workContextName || item.contextLabel || item.assignmentLabel || item.identityName || ''
      };
      if (isNotification) Object.assign(extra, { _showDelete: false, _swipeX: 0 });
      return Object.assign({}, item, extra);
    });
  },

  async loadMessageOverview() {
    if (this._messageOverviewLoading) {
      this._messageOverviewQueued = true;
      return;
    }
    this._messageOverviewLoading = true;
    const request = orgSession.beginRequest(this, 'portalMessages');
    const revision = this._messageRevision || 0;
    this.setData({ todoLoading: true, notificationLoading: true });
    try {
      const res = await callFunction({ name: 'getMessageOverview', data: { limit: 6 } });
      if (!orgSession.isRequestCurrent(this, request) || revision !== (this._messageRevision || 0) || res.status !== 'success') return;
      const todos = res.todos || {};
      const notifications = res.notifications || {};
      this.setData({
        todos: this.formatMessageItems(todos.items, false),
        todoCount: todos.total || 0,
        todoNextCursor: todos.nextCursor || '',
        notifications: this.formatMessageItems(notifications.items, true),
        notificationCount: notifications.unreadCount || 0,
        notificationNextCursor: notifications.nextCursor || '',
        messagePartial: !!res.partial
      });
    } catch (error) {
      if (!(error && error.silent)) console.error('[portal] message overview failed:', error);
    } finally {
      if (orgSession.isRequestCurrent(this, request)) {
        this.setData({ todoLoading: false, notificationLoading: false });
      }
      this._messageOverviewLoading = false;
      const shouldReload = this._messageOverviewQueued;
      this._messageOverviewQueued = false;
      if (shouldReload && this._isPageVisible && this.data.hasUser) {
        this.loadMessageOverview();
      }
    }
  },

  async loadMoreTodos() {
    if (!this.data.todoNextCursor || this.data.todoLoadingMore) return;
    const request = orgSession.beginRequest(this, 'portalTodoMore');
    const revision = this._messageRevision || 0;
    this.setData({ todoLoadingMore: true });
    try {
      const res = await callFunction({ name: 'listTodos', data: { limit: 20, cursor: this.data.todoNextCursor } });
      if (!orgSession.isRequestCurrent(this, request)
          || revision !== (this._messageRevision || 0)
          || res.status !== 'success') return;
      this.setData({
        todos: this.data.todos.concat(this.formatMessageItems(res.items, false)),
        todoCount: res.total || 0,
        todoNextCursor: res.nextCursor || '',
        messagePartial: !!res.partial
      });
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ todoLoadingMore: false });
    }
  },

  async loadMoreNotifications() {
    if (!this.data.notificationNextCursor || this.data.notificationLoadingMore) return;
    const request = orgSession.beginRequest(this, 'portalNotificationMore');
    const revision = this._messageRevision || 0;
    this.setData({ notificationLoadingMore: true });
    try {
      const res = await callFunction({ name: 'listNotifications', data: { limit: 20, cursor: this.data.notificationNextCursor } });
      if (!orgSession.isRequestCurrent(this, request)
          || revision !== (this._messageRevision || 0)
          || res.status !== 'success') return;
      this.setData({
        notifications: this.data.notifications.concat(this.formatMessageItems(res.items, true)),
        notificationCount: res.unreadCount || 0,
        notificationNextCursor: res.nextCursor || '',
        messagePartial: !!res.partial
      });
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ notificationLoadingMore: false });
    }
  },

  openMessageCenter(e) {
    const tab = e.currentTarget.dataset.tab === 'notifications' ? 'notifications' : 'todos';
    navigateToTrustedRoute('/subpackages/message/pages/messageCenter/messageCenter?tab=' + tab);
  },

  pendingReadStorageKey(organizationId) {
    return 'pendingNotificationReads:' + (organizationId || orgSession.getSnapshot().orgId || '') +
      ':' + (this.data.activeRole || '');
  },

  async retryPendingNotificationReads() {
    const key = this.pendingReadStorageKey();
    const ids = wx.getStorageSync(key) || [];
    if (!Array.isArray(ids) || !ids.length) return;
    const failed = [];
    for (const id of ids) {
      try {
        const result = await callFunction({
          name: 'markNotificationRead',
          data: { id: id, organizationId: orgSession.getSnapshot().orgId || '' }
        });
        if (result.status !== 'success') throw new Error(result.message || copy.messages.readFailed);
      }
      catch (_) { failed.push(id); }
    }
    if (failed.length) wx.setStorageSync(key, failed); else wx.removeStorageSync(key);
  },

  queuePendingNotificationRead(item) {
    try {
      const key = this.pendingReadStorageKey(item.organizationId);
      const queued = wx.getStorageSync(key) || [];
      if (Array.isArray(queued) && queued.indexOf(item.id) === -1) {
        queued.push(item.id);
        wx.setStorageSync(key, queued);
      }
    } catch (_) {}
  },

  async confirmNotificationOpened(item) {
    if (!item || !item.id) return;
    const current = (this.data.notifications || []).find(function(row) {
      return row.id === item.id;
    });
    if (current && !current.isRead) {
      this._messageRevision = (this._messageRevision || 0) + 1;
      this.setData({
        notifications: this.data.notifications.map(function(row) {
          return row.id === item.id
            ? Object.assign({}, row, { isRead: true, _showDelete: false })
            : row;
        }),
        notificationCount: Math.max(0, this.data.notificationCount - 1)
      });
    }
    try {
      const result = await callFunction({
        name: 'markNotificationRead',
        data: { id: item.id, organizationId: item.organizationId }
      });
      if (result.status !== 'success') throw new Error(result.message || copy.messages.readFailed);
    } catch (_) {
      this.queuePendingNotificationRead(item);
    }
  },

  async onTodoTap(e) {
    const id = e.currentTarget.dataset.id;
    const item = (this.data.todos || []).find(function(row) { return row.id === id; });
    if (!item) return;
    const switchKind = this.messageSwitchKind(item);
    if (switchKind === 'organization') {
      this.openMessageSwitchDialog(item, 'todo');
      return;
    }
    if (switchKind === 'context') {
      await this.activateMessageTarget(item, 'todo');
      return;
    }
    navigateToTrustedRoute(item.targetUrl);
  },

  async onNotificationTap(e) {
    if (this._notificationSwiping) return;
    const id = e.currentTarget.dataset.id;
    const current = (this.data.notifications || []).find(function(item) { return item.id === id; });
    if (!current) return;
    const switchKind = this.messageSwitchKind(current);
    if (switchKind === 'organization') {
      this.openMessageSwitchDialog(current, 'notification');
      return;
    }
    if (switchKind === 'context') {
      await this.activateMessageTarget(current, 'notification');
      return;
    }
    if (id && current && !current.isRead) {
      navigateToTrustedRoute(current.targetUrl, {
        success: () => { this.confirmNotificationOpened(current); }
      });
      return;
    }
    if (current.targetUrl) navigateToTrustedRoute(current.targetUrl);
  },

  messageSwitchKind(item) {
    if (!item) return '';
    if (item.organizationId
      && item.organizationId !== String(orgSession.getSnapshot().orgId || '')) {
      return 'organization';
    }
    const targetContextId = String(item.contextId || '') || authContext.resolveContextId(
      item.identityId,
      item.organizationId
    );
    if (targetContextId) {
      return targetContextId !== orgSession.getSnapshot().contextId
        ? 'context'
        : '';
    }
    if (item.contextId || item.identityId) return 'context';
    return '';
  },

  openMessageSwitchDialog(item, type) {
    this._pendingMessageNavigation = { item: item, type: type };
    const sameOrganization = item.organizationId === String(orgSession.getSnapshot().orgId || '');
    this.setData({
      showMessageSwitchDialog: true,
      messageSwitchTitle: sameOrganization ? copy.messages.switchWorkContext : copy.messages.switchOrganizationAndWorkContext,
      messageSwitchOrganizationName: (item.organizationName || copy.messages.targetOrganization)
        + (item.workContextName ? ' · ' + item.workContextName : '')
    });
  },

  closeMessageSwitchDialog() {
    if (this.data.messageSwitchLoading) return;
    this._pendingMessageNavigation = null;
    this.setData({
      showMessageSwitchDialog: false,
      messageSwitchOrganizationName: ''
    });
  },

  async activateMessageContext(item) {
    if (item.contextId) return authContext.activateContext(item.contextId);
    if (item.organizationId && item.identityId) {
      return authContext.activateSelection(item.organizationId, item.identityId);
    }
    return activateOrganization(item.organizationId);
  },

  async activateMessageTarget(item, type) {
    try {
      await this.activateMessageContext(item);
      this._activeOrgSnapshot = orgSession.getSnapshot();
      if (type === 'notification' && !item.isRead) {
        notificationReceipt.stage(item, orgSession.getSnapshot());
      }
      const launched = reLaunchPortalThenNavigate(item.targetUrl, {
        fail: function() { notificationReceipt.clear(item.id); }
      });
      if (!launched) notificationReceipt.clear(item.id);
    } catch (error) {
      const denied = error && ['org_access_denied', 'context_forbidden', 'not_found'].indexOf(error.status) >= 0;
      showShortToast(denied ? copy.messages.selectWorkContext : copy.messages.switchFailed);
      this.loadMessageOverview();
    }
  },

  async confirmMessageOrganizationSwitch() {
    const pending = this._pendingMessageNavigation;
    if (!pending || this.data.messageSwitchLoading) return;
    this.setData({ messageSwitchLoading: true });
    try {
      await this.activateMessageContext(pending.item);
      this._activeOrgSnapshot = orgSession.getSnapshot();
      if (pending.type === 'notification' && !pending.item.isRead) {
        notificationReceipt.stage(pending.item, orgSession.getSnapshot());
      }
      this._pendingMessageNavigation = null;
      this.setData({
        showMessageSwitchDialog: false,
        messageSwitchOrganizationName: '',
        messageSwitchLoading: false
      });
      const launched = reLaunchPortalThenNavigate(pending.item.targetUrl, {
        fail: function() { notificationReceipt.clear(pending.item.id); }
      });
      if (!launched) notificationReceipt.clear(pending.item.id);
    } catch (error) {
      const denied = error && (error.status === 'org_access_denied' || error.status === 'not_found');
      wx.showToast({ title: denied ? copy.messages.selectOrganization : copy.messages.switchFailed, icon: 'none' });
      this._pendingMessageNavigation = null;
      this.setData({
        showMessageSwitchDialog: false,
        messageSwitchOrganizationName: '',
        messageSwitchLoading: false
      });
      this.loadMessageOverview();
    }
  },

  onNotificationTouchStart(e) {
    const touch = e.touches && e.touches[0] ? e.touches[0] : null;
    const id = e.currentTarget.dataset.id;
    const current = (this.data.notifications || []).find(function(item) { return item.id === id; });
    this._notificationTouch = {
      id: id,
      startX: touch ? touch.clientX : 0,
      startY: touch ? touch.clientY : 0,
      baseX: current && current._showDelete ? -NOTIFICATION_DELETE_WIDTH_PX : 0,
      moving: false
    };
  },

  onNotificationTouchMove(e) {
    const touchState = this._notificationTouch || {};
    const touch = e.touches && e.touches[0] ? e.touches[0] : null;
    const id = touchState.id;
    if (!id || !touch) return;

    const dx = touch.clientX - touchState.startX;
    const dy = touch.clientY - touchState.startY;
    if (!touchState.moving && Math.abs(dx) < 8) return;
    if (!touchState.moving && Math.abs(dy) > Math.abs(dx)) return;

    touchState.moving = true;
    this._notificationTouch = touchState;

    const nextX = Math.max(-NOTIFICATION_DELETE_WIDTH_PX, Math.min(0, touchState.baseX + dx));
    const notifications = this.data.notifications.map(function(item) {
      if (item.id !== id) return Object.assign({}, item, { _showDelete: false, _swipeX: 0 });
      return Object.assign({}, item, { _swipeX: nextX, _showDelete: nextX <= -NOTIFICATION_DELETE_WIDTH_PX / 2 });
    });
    this.setData({ notifications: notifications });
  },

  onNotificationTouchEnd(e) {
    const touchState = this._notificationTouch || {};
    const touch = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null;
    const id = touchState.id || e.currentTarget.dataset.id;
    if (!id || !touchState.moving) return;

    this._notificationSwiping = true;
    const that = this;
    setTimeout(function() { that._notificationSwiping = false; }, 250);

    const current = (this.data.notifications || []).find(function(item) { return item.id === id; }) || {};
    const currentX = typeof current._swipeX === 'number' ? current._swipeX : 0;
    const dx = touch ? (touch.clientX - touchState.startX) : 0;
    const showDelete = currentX <= -NOTIFICATION_DELETE_WIDTH_PX / 2 || dx < -40;
    const notifications = this.data.notifications.map(function(item) {
      return Object.assign({}, item, {
        _showDelete: item.id === id ? showDelete : false,
        _swipeX: item.id === id && showDelete ? -NOTIFICATION_DELETE_WIDTH_PX : 0
      });
    });
    this.setData({ notifications: notifications });
    this._notificationTouch = null;
  },

  async deleteNotification(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const previous = this.data.notifications;
    this._messageRevision = (this._messageRevision || 0) + 1;
    const deleted = previous.find(function(item) { return item.id === id; });
    const notifications = previous.filter(function(item) { return item.id !== id; });
    this.setData({
      notifications: notifications,
      notificationCount: deleted && !deleted.isRead ? Math.max(0, this.data.notificationCount - 1) : this.data.notificationCount
    });
    try {
      const result = await callFunction({
        name: 'deleteNotification',
        data: { id: id, organizationId: deleted && deleted.organizationId }
      });
      if (result.status !== 'success') throw new Error(result.message || copy.messages.deleteFailed);
    } catch (err) {
      console.error('[portal] deleteNotification failed:', err);
      this.setData({ notifications: previous });
      this.loadMessageOverview();
    }
  },

  async markAllNotificationsRead() {
    if (!this.data.notificationCount) return;
    this._messageRevision = (this._messageRevision || 0) + 1;
    const previous = {
      notifications: this.data.notifications,
      notificationCount: this.data.notificationCount,
      messagePartial: this.data.messagePartial
    };
    this.setData({
      notifications: previous.notifications.map(function(item) { return Object.assign({}, item, { isRead: true }); }),
      notificationCount: 0
    });
    try {
      const result = await callFunction({ name: 'markAllNotificationsRead', data: {} });
      if (result.status !== 'success') throw new Error(result.message || copy.messages.readFailed);
      if (isPartialBulkResult(result)) {
        this.setData(previous);
        await this.loadMessageOverview();
        showShortToast(copy.messages.partialBulkAction);
      }
    } catch (error) {
      this.setData(previous);
      await this.loadMessageOverview();
      showShortToast(copy.messages.incomplete);
    }
  },

  // ── 每 30 秒轮询刷新消息概览 ──
  startPolling() {
    this.stopPolling();
    const that = this;
    this._pollTimer = setInterval(function() {
      if (that._isPageVisible && that.data.hasUser) {
        that.loadMessageOverview();
      }
    }, 30000);
  },

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  // ── 审批完成后通过事件总线刷新 ──
  _onApprovalDone: function() {
    if (this._isPageVisible && this.data.hasUser) {
      this.loadMessageOverview();
    }
  },

  goLogin() {
    navigateToTrustedRoute('/subpackages/org/pages/identitySwitch/identitySwitch');
  },

  noop() {},

  logout() {
    authContext.clearUnifiedAuthentication();
    const pages = getCurrentPages();
    const previousPage = pages.length > 1 ? pages[pages.length - 2] : null;
    if (previousPage && previousPage.route === 'subpackages/main/pages/login/login') {
      wx.navigateBack();
      return;
    }
    wx.reLaunch({ url: '/subpackages/main/pages/login/login' });
  },

});
