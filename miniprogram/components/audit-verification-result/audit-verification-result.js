const copy = require('../../locales/zh-CN/signingEvidence');
const { formatDetailTime } = require('../../utils/dateTime');
const reportTransfer = require('../../utils/auditVerificationReport');
const orgSession = require('../../utils/orgSession');
const states = ['passed', 'failed', 'indeterminate', 'legacy_partial'];
function status(value) { return states.indexOf(value) >= 0 ? value : 'indeterminate'; }
function details(source, names) {
  return names.filter(key => source[key] !== undefined && source[key] !== '').map(key => ({
    key, label: copy[key] || key, value: Array.isArray(source[key]) ? source[key].join(' / ') : String(source[key])
  }));
}
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    result: { type: Object, value: null, observer: 'present' },
    resultJson: { type: String, value: '', observer: 'presentJson' },
    report: { type: Boolean, value: false }
  },
  data: { copy, view: null, exporting: false },
  lifetimes: { detached: function() { orgSession.invalidateRequests(this); } },
  methods: {
    presentJson: function(value) {
      if (!value) { this.present(null); return; }
      try { this.present(JSON.parse(value)); }
      catch (_) { this.present({ verificationVersion: 2, overallStatus: 'indeterminate', files: [] }); }
    },
    present: function(result) {
      this._reportResult = result;
      if (!result) { this.setData({ view: null }); return; }
      const sourceFiles = Array.isArray(result.files) ? result.files : [];
      const shapeValid = Array.isArray(result.files) && sourceFiles.every(file => file && typeof file === 'object'
        && (file.cms === undefined || Array.isArray(file.cms)) && (file.steps === undefined || Array.isArray(file.steps))
        && (file.cms || []).every(item => item && typeof item === 'object')
        && (file.steps || []).every(item => item && typeof item === 'object'));
      const requested = result.verificationVersion === 2 ? status(result.overallStatus) : 'legacy_partial';
      const overall = !shapeValid || (requested === 'passed' && !sourceFiles.length) ? 'indeterminate' : requested;
      const files = (shapeValid ? sourceFiles : []).map((file, index) => ({
        key: String(index), name: file.fileName || copy.file, state: status(file.overallStatus),
        stateText: copy.statuses[status(file.overallStatus)], fileDigest: file.currentHash || '',
        checks: Object.keys(copy.checks).map(key => {
          const value = file.checks && file.checks[key] || {};
          return { key, label: copy.checks[key], state: status(value.status), stateText: copy.statuses[status(value.status)],
            reasonCode: value.reasonCode || '', reasonText: copy.reasons[value.reasonCode] || copy.unknownReason };
        }),
        summary: Object.keys(copy.fileChecks).map(key => {
          const value = file.checks && file.checks[key] || {};
          return { key, label: copy.fileChecks[key], state: status(value.status), text: copy.simpleResults[key][status(value.status)] };
        }),
        certificates: (Array.isArray(file.certificates) ? file.certificates : []).filter(item => item
          && /^[a-f0-9]{64}$/.test(item.fingerprint) && typeof item.derBase64 === 'string'
          && item.derBase64.length <= 90000).map(item => ({ fingerprint: item.fingerprint, derBase64: item.derBase64 })),
        cms: (file.cms || []).map((item, cmsIndex) => ({ key: String(cmsIndex),
          fields: details(item, ['algorithm', 'certificateFingerprint', 'byteRange', 'signedBytesDigest']),
          coverage: item.wholeDocument ? copy.yes : copy.no })),
        steps: (file.steps || []).map(item => ({ key: item.reference,
          name: item.status === 'passed' ? item.name : copy.identityUnknown,
          assignment: item.status === 'passed' ? item.assignment : '', organization: item.status === 'passed' ? item.organization : '',
          personText: item.status === 'passed' && Number.isInteger(item.personIndex) && item.personIndex > 0 ? copy.signerLabel(item.personIndex) : '',
          title: copy.stepTitle(item.round, item.step, copy.actions[item.action] || ''),
          signedAtText: formatDetailTime(item.signedAt),
          state: status(item.status), stateText: item.status === 'passed' ? copy.identityConfirmed : copy.identityUnknown, digestTypeText: copy.digestTypes[item.outputDigestType] || '',
          fields: details(item, ['reference', 'algorithm', 'identityAlgorithm', 'snapshotAlgorithm', 'keyVersion',
            'certificateFingerprint', 'inputDigest', 'outputDigest', 'previousDigest', 'receiptDigest']) }))
      }));
      const fileOnly = result.verificationScope === 'file_only';
      const fileChecks = shapeValid && sourceFiles.length === 1 && sourceFiles[0].checks || {};
      const fileSignatureValid = fileOnly && fileChecks.documentIntegrity && fileChecks.documentIntegrity.status === 'passed'
        && fileChecks.cmsSignature && fileChecks.cmsSignature.status === 'passed';
      const unsigned = fileOnly && fileChecks.cmsSignature && fileChecks.cmsSignature.reasonCode === 'pdf_unsigned';
      this.setData({ view: { state: overall,
        title: fileSignatureValid ? copy.fileOnlyValid : unsigned ? copy.unsignedFile : copy.statuses[overall],
        notice: fileOnly ? copy.fileOnlyNotice : '',
        source: copy.sources[result.verificationSource] || copy.noFiles, files } });
    },
    openReport: function() { if (this._reportResult) reportTransfer.open(this._reportResult); },
    exportCertificate: function(event) {
      if (this.data.exporting) return;
      const file = this.data.view.files[Number(event.currentTarget.dataset.file)];
      const certificate = file && file.certificates[Number(event.currentTarget.dataset.certificate)];
      if (!certificate) return;
      const safeToken = String(certificate.fingerprint || '');
      if (!/^[a-f0-9]{64}$/.test(safeToken)) return;
      if (typeof wx.shareFileMessage !== 'function') {
        wx.showModal({ title: copy.certificateTitle, content: copy.exportUnavailable, showCancel: false }); return;
      }
      const request = orgSession.beginRequest(this, 'certificateExport');
      const fs = wx.getFileSystemManager();
      const fileName = 'WHUSU-' + safeToken + '.cer';
      const filePath = wx.env.USER_DATA_PATH + '/WHUSU-' + safeToken + '.cer';
      this.setData({ exporting: true });
      const finish = () => {
        fs.unlink({ filePath, fail: function() {} });
        if (orgSession.isRequestCurrent(this, request)) this.setData({ exporting: false });
      };
      fs.writeFile({ filePath, data: certificate.derBase64, encoding: 'base64', success: () => {
        if (!orgSession.isRequestCurrent(this, request)) { finish(); return; }
        wx.shareFileMessage({ filePath, fileName, fail: error => {
          if (orgSession.isRequestCurrent(this, request) && !/cancel/i.test(String(error && error.errMsg || ''))) {
            wx.showModal({ title: copy.certificateTitle, content: copy.exportFailed, showCancel: false });
          }
        }, complete: finish });
      }, fail: () => {
        if (orgSession.isRequestCurrent(this, request)) wx.showModal({ title: copy.certificateTitle, content: copy.exportFailed, showCancel: false });
        finish();
      } });
    }
  }
});
