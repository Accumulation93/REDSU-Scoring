const { requestOptionalWechatBinding, showShortToast } = require('./api');
const orgSession = require('./orgSession');
const { passwordBinding: copy } = require('../locales/zh-CN/main');

let pending = null;

function queue(enabled) {
  pending = enabled ? { session: orgSession.getSnapshot(), expiresAt: Date.now() + 30000 } : null;
}

function cancel(page) {
  const work = page._passwordBindingWork;
  if (!work) return;
  page._passwordBindingWork = null;
  work.cancelled = true;
  if (work.timer) clearTimeout(work.timer);
  if (work.request && typeof work.request.abort === 'function') work.request.abort();
}

function start(page) {
  const ticket = pending;
  pending = null;
  if (!ticket || Date.now() > ticket.expiresAt) return;
  cancel(page);
  const work = { cancelled: false, timer: null, request: null };
  page._passwordBindingWork = work;
  const current = function() {
    const now = orgSession.getSnapshot();
    return !work.cancelled && page._isPageVisible && ticket.session.token
      && now.token === ticket.session.token && now.contextId === ticket.session.contextId
      && now.orgId === ticket.session.orgId;
  };
  const finish = function() { if (page._passwordBindingWork === work) cancel(page); };
  const request = function(path, code, done) {
    if (!current()) return finish();
    const failed = function() {
      if (current() && path === 'auth/security/bind-current-wechat') showShortToast(copy.failed);
      finish();
    };
    // 可选检查不能触发通用 API 的重新登录、身份切换或请求重放。
    try { work.request = requestOptionalWechatBinding({
      name: path, session: ticket.session, code,
      success(response) {
        if (!current()) return finish();
        let data = response.data;
        try { if (typeof data === 'string') data = JSON.parse(data); } catch (_) { return failed(); }
        if (response.statusCode !== 200 || !data || data.status !== 'success') return failed();
        done(data);
      },
      fail: failed
    }); } catch (_) { failed(); }
  };
  const wechatCode = function(done) {
    if (!current() || typeof wx.login !== 'function') return finish();
    let settled = false;
    work.timer = setTimeout(finish, 8000);
    try { wx.login({
      timeout: 8000,
      success(result) {
        if (settled) return;
        settled = true;
        if (work.timer) clearTimeout(work.timer);
        work.timer = null;
        if (!current() || !result || !result.code) return finish();
        done(result.code);
      }, fail: finish
    }); } catch (_) { finish(); }
  };
  // 门户已进入后才启动；检查失败、离页及角色变化均静默放弃本次邀请。
  work.timer = setTimeout(function() {
    work.timer = null;
    wechatCode(function(code) {
      request('auth/security/wechat-binding-offer', code, function(result) {
        if (result.available !== true || !current() || typeof wx.showModal !== 'function') return finish();
        try { wx.showModal({
          title: copy.title, content: copy.note,
          confirmText: copy.confirm, cancelText: copy.cancel,
          success(answer) {
            if (!answer.confirm || !current()) return finish();
            // 检查用 code 不可复用；最终绑定必须重新校验双方是否仍未绑定。
            wechatCode(function(freshCode) {
              request('auth/security/bind-current-wechat', freshCode, function() {
                if (current()) showShortToast(copy.success);
                finish();
              });
            });
          }, fail: finish
        }); } catch (_) { finish(); }
      });
    });
  }, 0);
}

module.exports = { queue, start, cancel };
