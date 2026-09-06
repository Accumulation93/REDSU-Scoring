const copy = require('../../locales/zh-CN/signingEvidence');
const { formatDetailTime } = require('../../utils/dateTime');
const reportTransfer = require('../../utils/auditVerificationReport');
const orgSession = require('../../utils/orgSession');
const states = ['passed', 'failed', 'indeterminate', 'legacy_partial'];
function status(value) { return states.indexOf(value) >= 0 ? value : 'indeterminate'; }
function platformIdentityVerified(file) {
  const checks = file.checks || {};
  return ['documentIntegrity', 'cmsSignature', 'identityBinding', 'platformCertificate'].every(key => checks[key] && checks[key].status === 'passed')
    && checks.receiptChain && ['passed', 'legacy_partial'].indexOf(checks.receiptChain.status) >= 0;
}
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
      const complete = shapeValid && sourceFiles.length > 0 && sourceFiles.every(file => platformIdentityVerified(file)
        && file.checks.receiptChain.status === 'passed' && file.overallStatus === 'passed');
      const overall = !shapeValid || (requested === 'passed' && !complete) ? 'indeterminate' : requested;
      const files = (shapeValid ? sourceFiles : []).map((file, index) => ({
        key: String(index), name: file.fileName || copy.file,
        platformVerified: result.verificationVersion === 2 && Boolean(platformIdentityVerified(file)),
        state: file.overallStatus === 'passed' && !platformIdentityVerified(file) ? 'indeterminate' : status(file.overallStatus),
        stateText: copy.statuses[file.overallStatus === 'passed' && !platformIdentityVerified(file) ? 'indeterminate' : status(file.overallStatus)], fileDigest: file.currentHash || '',
        checks: Object.keys(copy.checks).map(key => {
          const value = file.checks && file.checks[key] || {};
          return { key, label: copy.checks[key], state: status(value.status), stateText: copy.statuses[status(value.status)],
            reasonCode: value.reasonCode || '', reasonText: copy.reasons[value.reasonCode] || copy.unknownReason };
        }),
        summary: Object.keys(copy.fileChecks).map(key => {
          const value = file.checks && file.checks[key] || {};
          return { key, label: copy.fileChecks[key], state: status(value.status), text: copy.simpleResults[key][status(value.status)] };
        }),
        certificates: (result.verificationVersion === 2 && platformIdentityVerified(file) && Array.isArray(file.certificates) ? file.certificates : []).filter(item => item
          && /^[a-f0-9]{64}$/.test(item.fingerprint) && typeof item.derBase64 === 'string'
          && item.derBase64.length <= 90000).map(item => ({ fingerprint: item.fingerprint, derBase64: item.derBase64 })),
        cms: (file.cms || []).map((item, cmsIndex) => ({ key: String(cmsIndex),
          fields: details(item, ['algorithm', 'certificateFingerprint', 'byteRange', 'signedBytesDigest']),
          coverage: item.wholeDocument ? copy.yes : copy.no })),
        steps: (result.verificationVersion === 2 && platformIdentityVerified(file) ? file.steps || [] : []).map(item => ({ key: item.reference,
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
      if (typeof wx.shareFileMessage !== 'function' && typeof wx.saveFileToDisk !== 'function') {
        wx.showModal({ title: copy.certificateTitle, content: copy.exportUnavailable, showCancel: false }); return;
      }
      let fs;
      try {
        fs = wx.getFileSystemManager();
        if (!fs || typeof fs.writeFile !== 'function' || !wx.env || !wx.env.USER_DATA_PATH) throw new Error('unavailable');
      } catch (_) {
        wx.showModal({ title: copy.certificateTitle, content: copy.exportWriteFailed, showCancel: false }); return;
      }
      const request = orgSession.beginRequest(this, 'certificateExport');
      const fileName = 'WHUSU-' + safeToken + '.cer';
      const filePath = wx.env.USER_DATA_PATH + '/WHUSU-' + safeToken + '.cer';
      this.setData({ exporting: true });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try { fs.unlink({ filePath, fail: function() {} }); } catch (_) {}
        if (orgSession.isRequestCurrent(this, request)) this.setData({ exporting: false });
      };
      const fail = message => {
        if (orgSession.isRequestCurrent(this, request)) wx.showModal({ title: copy.certificateTitle, content: message, showCancel: false });
        finish();
      };
      // 原生接口存在不代表当前运行端支持；电脑保存与手机分享互为备用路径。
      let platform = '';
      try { if (typeof wx.getDeviceInfo === 'function') platform = wx.getDeviceInfo().platform || ''; } catch (_) {}
      const actions = /^(windows|mac|devtools)$/.test(platform)
        ? ['saveFileToDisk', 'shareFileMessage'] : ['shareFileMessage', 'saveFileToDisk'];
      const attempt = index => {
        if (finished) return;
        if (!orgSession.isRequestCurrent(this, request)) { finish(); return; }
        if (index >= actions.length) { fail(copy.exportFailed); return; }
        const action = actions[index];
        if (typeof wx[action] !== 'function') { attempt(index + 1); return; }
        let settled = false;
        const failure = error => {
          if (settled) return;
          settled = true;
          if (/cancel/i.test(String(error && (error.errMsg || error.message) || ''))) { finish(); return; }
          attempt(index + 1);
        };
        try {
          wx[action]({ filePath, ...(action === 'shareFileMessage' ? { fileName } : {}),
            success: () => { if (!settled) { settled = true; finish(); } }, fail: failure });
        } catch (error) { failure(error); }
      };
      try {
        fs.writeFile({ filePath, data: certificate.derBase64, encoding: 'base64',
          success: () => attempt(0), fail: () => fail(copy.exportWriteFailed) });
      } catch (_) { fail(copy.exportWriteFailed); }
    },
    copyCertificate: function(event) {
      const file = this.data.view && this.data.view.files[Number(event.currentTarget.dataset.file)];
      const certificate = file && file.certificates[Number(event.currentTarget.dataset.certificate)];
      if (!certificate || typeof wx.setClipboardData !== 'function') return;
      // PEM 只重新编码已验证的公开 DER 证书，不生成或更换签署身份。
      const lines = certificate.derBase64.match(/.{1,64}/g);
      if (!lines) return;
      const request = orgSession.beginRequest(this, 'certificateCopy');
      const data = '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----\n';
      wx.setClipboardData({ data, success: () => {
        if (orgSession.isRequestCurrent(this, request)) wx.showModal({ title: copy.certificateCopied,
          content: copy.certificateTextGuide, showCancel: false });
      }, fail: () => {
        if (orgSession.isRequestCurrent(this, request)) wx.showModal({ title: copy.certificateTitle,
          content: copy.certificateCopyFailed, showCancel: false });
      } });
    }
  }
});
