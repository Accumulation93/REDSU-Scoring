const copy = require('../../../../locales/zh-CN/signingEvidence');
const transfer = require('../../../../utils/auditVerificationReport');
const orgSession = require('../../../../utils/orgSession');

Page({
  data: { copy, resultJson: '' },
  onLoad: function() {
    wx.setNavigationBarTitle({ title: copy.reportNavigationTitle });
    const report = transfer.take();
    this._reportSnapshot = report && report.snapshot;
    this.setData({ resultJson: report ? report.json : '' });
  },
  onShow: function() {
    const context = orgSession.consume(this);
    if (context.changed) orgSession.invalidateRequests(this);
    if (!this._reportSnapshot || !orgSession.isCurrent(this._reportSnapshot)) {
      this._reportSnapshot = null;
      this.setData({ resultJson: '' });
    }
  },
  onUnload: function() {
    orgSession.invalidateRequests(this);
    this._reportSnapshot = null;
  }
});
