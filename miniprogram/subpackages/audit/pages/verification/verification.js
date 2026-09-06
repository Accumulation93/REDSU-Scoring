const localeCopy = require('../../../../locales/zh-CN/generated/subpackages/audit/pages/verification/verification');
const { callFunction, getErrorText, showShortToast } = require('../../../../utils/api');
const {
  verificationCopy,
  presentVerificationResponse,
  buildMatchVerificationParams
} = require('../../../../utils/auditVerification');
const orgSession = require('../../../../utils/orgSession');
const signingCopy = require('../../../../locales/zh-CN/signingEvidence');

Page({
  onLoad() {
    wx.setNavigationBarTitle({ title: localeCopy.navigationTitle });
  },
  data: {
    localeCopy,
    verificationCopy,
    verifyMode: 'number',       // 'number' | 'file'
    submissionNumber: '',
    fileName: '',
    filePath: '',
    fileBase64: '',
    fileSize: 0,
    loading: false,
    result: null
  },

  onShow() {
    if (!orgSession.consume(this).changed) return;
    orgSession.invalidateRequests(this);
    this.setData({ result: null, submissionNumber: '', fileName: '', filePath: '', fileBase64: '', fileSize: 0, loading: false });
  },

  // 原生选文件会临时隐藏页面；只作废验签请求，保留受组织及卸载保护的文件选择回调。
  onHide() {
    orgSession.beginRequest(this, 'auditVerification');
    if (this.data.loading) this.setData({ loading: false });
  },
  onUnload() { orgSession.invalidateRequests(this); },

  onVerifyModeChange(e) {
    const modes = ['number', 'file'];
    this.setData({ verifyMode: modes[e.detail.value] || 'number', result: null });
  },

  onInputNumber(e) {
    this.setData({ submissionNumber: e.detail.value });
  },

  chooseVerifyFile() {
    const that = this;
    const request = orgSession.beginRequest(this, 'verificationFileRead');
    wx.chooseMessageFile({
      count: 1,
      type: 'all',
      success: function(res) {
        if (!orgSession.isRequestCurrent(that, request)) return;
        let file = res.tempFiles[0];
        if (!file || file.size > 10 * 1024 * 1024) { showShortToast(signingCopy.fileTooLarge); return; }
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          encoding: 'base64',
          success: function(readRes) {
            if (!orgSession.isRequestCurrent(that, request)) return;
            that.setData({
              filePath: file.path,
              fileName: file.name,
              fileBase64: readRes.data,
              fileSize: file.size,
              result: null
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

  async verify() {
    const request = orgSession.beginRequest(this, 'auditVerification');
    let params = {};
    let mode = this.data.verifyMode;

    if (mode === 'number') {
      let number = this.data.submissionNumber.trim();
      if (!number) { showShortToast(localeCopy.copy_93eb240494); return; }
      params.submissionNumber = number;
    } else if (mode === 'file') {
      let fileB64 = this.data.fileBase64;
      if (!fileB64) { showShortToast(localeCopy.copy_cbf65b3559); return; }
      params.fileBase64 = fileB64;
    }

    this.setData({ loading: true, result: null });
    try {
      const res = await callFunction({ name: 'verifySignatureChain', data: params });
      if (!orgSession.isRequestCurrent(this, request)) return;
      if (res.status === 'success') {
        this.setData({ result: presentVerificationResponse(res) });
      } else if (res.status === 'forbidden') {
        showShortToast(localeCopy.copy_d1cbed9945);
      } else {
        showShortToast(res.message || localeCopy.copy_b791913c7a);
      }
    } catch (e) {
      if (!orgSession.isRequestCurrent(this, request)) return;
      showShortToast(getErrorText(e, localeCopy.copy_b791913c7a));
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ loading: false });
    }
  },

  async selectVerificationMatch(e) {
    const submissionId = e.detail && e.detail.submissionId
      ? e.detail.submissionId
      : e.currentTarget.dataset.submissionId;
    const params = buildMatchVerificationParams(this.data.result, submissionId, this.data.fileBase64);
    if (!params || params.submissionId === String(this.data.result && this.data.result.submissionId || '')) return;
    const request = orgSession.beginRequest(this, 'auditVerification');
    this.setData({ loading: true });
    try {
      const res = await callFunction({ name: 'verifySignatureChain', data: params });
      if (!orgSession.isRequestCurrent(this, request)) return;
      if (res.status === 'success') {
        this.setData({ result: presentVerificationResponse(res) });
      } else {
        showShortToast(res.message || localeCopy.copy_b791913c7a);
      }
    } catch (error) {
      if (!orgSession.isRequestCurrent(this, request)) return;
      showShortToast(getErrorText(error, localeCopy.copy_b791913c7a));
    } finally {
      if (orgSession.isRequestCurrent(this, request)) this.setData({ loading: false });
    }
  }
});
