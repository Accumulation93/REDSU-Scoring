'use strict';

const stampCopy = require('../../../../../locales/zh-CN/stampAuthorization');
const orgSession = require('../../../../../utils/orgSession');
const { showShortToast, getErrorText } = require('../../../../../utils/api');

module.exports = Behavior({
  data: {
    stampCopy, stampLoadError: '', stampGrantVisible: false, stampGrantId: '', stampGrantContext: '',
    stampGrantOptions: [], stampGrantValue: [], stampGrantLoading: false, stampGrantSaving: false, stampGrantError: ''
  },
  methods: {
    openStampGrants: function(event) {
      if (this.data.stampGrantSaving || this.data.stampLoadError) return;
      const id = event.currentTarget.dataset.id;
      const stamp = (this.data.stamps || []).find(item => item.id === id);
      if (!stamp) return;
      const people = stamp.assignedPeople || [];
      this.setData({
        stampGrantVisible: true, stampGrantId: id,
        stampGrantContext: stampCopy.editorContext(stamp.name) + '\n' + stampCopy.scope
          + (people.some(item => !item.available) ? '\n' + stampCopy.invalidRemoved : ''),
        stampGrantValue: people.filter(item => item.available).map(item => item.assignmentId),
        stampGrantOptions: [], stampGrantError: ''
      });
      this.loadStampGrantCandidates();
    },
    loadStampGrantCandidates: async function() {
      if (!this.data.stampGrantVisible) return;
      const stampId = this.data.stampGrantId;
      const request = orgSession.beginRequest(this, 'stampGrantCandidates');
      this.setData({ stampGrantLoading: true, stampGrantError: '' });
      try {
        const result = await this.callCloud('listStampCandidates', {});
        if (!orgSession.isRequestCurrent(this, request) || !this.data.stampGrantVisible || this.data.stampGrantId !== stampId) return;
        if (result.status !== 'success') throw new Error(result.message || stampCopy.candidatesFailed);
        this.setData({ stampGrantOptions: result.candidates || [], stampGrantLoading: false });
      } catch (error) {
        if (!orgSession.isRequestCurrent(this, request) || !this.data.stampGrantVisible || this.data.stampGrantId !== stampId) return;
        this.setData({ stampGrantLoading: false, stampGrantError: getErrorText(error, stampCopy.candidatesFailed) });
      }
    },
    closeStampGrants: function() {
      if (this.data.stampGrantSaving) return;
      orgSession.beginRequest(this, 'stampGrantCandidates');
      this.setData({ stampGrantVisible: false, stampGrantId: '', stampGrantOptions: [], stampGrantValue: [], stampGrantError: '' });
    },
    confirmStampGrants: async function(event) {
      if (!this.data.stampGrantVisible || this.data.stampGrantLoading || this.data.stampGrantSaving || this.data.stampGrantError) return;
      const stampId = this.data.stampGrantId;
      const assignmentIds = event.detail.keys;
      if (!Array.isArray(assignmentIds)) return;
      const request = orgSession.beginRequest(this, 'stampGrantSave');
      this.setData({ stampGrantSaving: true });
      try {
        const result = await this.callCloud('saveStampGrants', { stampId, assignmentIds });
        if (!orgSession.isRequestCurrent(this, request)) return;
        if (result.status !== 'success') throw new Error(result.message || stampCopy.saveFailed);
        this.setData({ stampGrantSaving: false });
        this.closeStampGrants();
        showShortToast(stampCopy.saved);
        await this.loadStamps();
      } catch (error) {
        if (!orgSession.isRequestCurrent(this, request)) return;
        this.setData({ stampGrantSaving: false, stampGrantError: getErrorText(error, stampCopy.saveFailed) });
      }
    }
  }
});
