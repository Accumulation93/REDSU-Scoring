const localeCopy = require('../../../../../locales/zh-CN/generated/subpackages/scoring/pages/admin/modules/authPersonnelBehavior');
const { callFunction, showShortToast, getErrorText, formatAuditTime, formatAuditDetailTime } = require('../../../../../utils/api');
const authContext = require('../../../../../utils/authContext');
const orgSession = require('../../../../../utils/orgSession');
const dateTime = require('../../../../../utils/dateTime');

const DIRECTORY_LIMIT = 2000;

function splitPolicyDateTime(value) {
  return value ? dateTime.splitSystemDateTime(value) : { date: '', time: '' };
}

function combinePolicyDateTime(date, time) {
  return date ? dateTime.systemDateTimeToIsoUtc(date, time || '00:00') : '';
}

function decorateClaim(item) {
  return Object.assign({}, item, {
    selected: false,
    createdText: formatAuditTime(String(item.createdAt || ''), item.createdAtReviewStatus),
    expiresText: formatAuditTime(String(item.expiresAt || ''), item.expiresAtReviewStatus)
  });
}

function decorateAccount(item) {
  const labels = {
    verified: localeCopy.copy_8e4abe3d58,
    frozen: localeCopy.copy_ddaba44b59,
    recovery_required: localeCopy.copy_16399ef078
  };
  return Object.assign({}, item, {
    selected: false,
    statusLabel: labels[item.accountStatus] || localeCopy.copy_8e4abe3d58
  });
}

function decorateGovernanceRow(item, selected) {
  const hasGovernance = Boolean(item && item.auth);
  const auth = Object.assign({}, item && item.auth || {});
  const bindStatus = String(item && item.wxBindStatus
    || (auth.hasActiveBinding ? 'bound' : 'unbound'));
  let accountState = 'unknown';
  let accountStateText = localeCopy.accountStateUnknown;
  let accountStateClass = 'unbound-chip';
  if (auth.status === 'frozen') {
    accountState = 'frozen';
    accountStateText = localeCopy.copy_f6eb285e87;
    accountStateClass = 'frozen-chip';
  } else if (auth.status === 'recovery_required') {
    accountState = 'recovery_required';
    accountStateText = localeCopy.copy_16399ef078;
    accountStateClass = 'activation-chip';
  } else if (auth.status === 'verified') {
    accountState = 'verified';
    accountStateText = localeCopy.copy_8e4abe3d58;
    accountStateClass = 'current-chip';
  } else if (hasGovernance && !item.accountId) {
    accountState = 'unbound';
    accountStateText = localeCopy.accountNotCreated;
  } else if (auth.status === 'pending_verification') {
    accountState = 'pending_verification';
    accountStateText = localeCopy.accountPendingVerification;
    accountStateClass = 'activation-chip';
  }
  const verificationText = auth.hasActiveClaimCode || auth.hasActiveInvite
    ? localeCopy.copy_ddd0a0c28a
    : auth.hasPendingClaim
      ? localeCopy.copy_2b6803bda1
      : auth.hasBindingHistory
        ? localeCopy.copy_4c36a79f14
        : localeCopy.copy_202391487f;
  const recoveryText = auth.hasRecoveryCode
    ? localeCopy.copy_2e5c18ad5a
    : item && item.accountId
      ? localeCopy.copy_a2c1301ea7
      : localeCopy.copy_2f9c8ba49c;
  return Object.assign({}, item, {
    auth,
    wxBindStatus: bindStatus,
    governanceAvailable: hasGovernance,
    selected: Boolean(selected),
    accountState,
    accountStateText,
    accountStateClass,
    verificationText,
    recoveryText,
    showVerificationStatus: accountState === 'unbound' || accountState === 'pending_verification',
    canIssueVerification: Boolean(hasGovernance && auth.status === 'pending_verification'
      && (auth.hasPendingClaim || !auth.hasBindingHistory)),
    canRevokeVerification: Boolean(hasGovernance && (auth.hasActiveClaimCode || auth.hasActiveInvite)),
    canIssueRecovery: Boolean(hasGovernance && item && item.accountId && auth.status !== 'frozen'),
    canRevokeRecovery: Boolean(hasGovernance && item && item.accountId && auth.hasRecoveryCode && auth.status !== 'frozen'),
    canUnbindWechat: Boolean(hasGovernance && item && item.personId && (bindStatus === 'bound' || auth.hasActiveBinding)),
    canSelectForAuth: Boolean(hasGovernance && (
      (auth.hasPendingClaim || !auth.hasBindingHistory)
      || (item && item.accountId && auth.status !== 'frozen')
    ))
  });
}

function matchesKeyword(item, keyword) {
  if (!keyword) return true;
  const text = [item.name, item.studentId, item.organizationName,
    item.requestedOrganizationName, item.departmentName, item.identityName,
    item.workGroupName].filter(Boolean).join(' ').toLowerCase();
  return text.indexOf(keyword.toLowerCase()) >= 0;
}

function uniquePeople(rows) {
  const seen = new Set();
  return (rows || []).filter(function(item) {
    const id = String(item.personId || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function splitIntoBatches(ids, size) {
  const rows = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  const batches = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }
  return batches;
}

async function runBatchedAuthAction(options) {
  const batches = splitIntoBatches(options.ids, options.batchSize);
  const results = [];
  const completedIds = [];
  const failures = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batchIds = batches[index];
    try {
      const data = Object.assign({}, options.extraData || {}, {
        action: options.action,
        [options.idField]: batchIds
      });
      const result = await callFunction({ name: options.name, data });
      if (result.status !== 'success') throw new Error(result.message || options.failureMessage);
      results.push(result);
      completedIds.push.apply(completedIds, batchIds);
    } catch (error) {
      failures.push(error);
    }
  }
  if (!results.length && failures.length) throw failures[0];
  return { results, completedIds, failures };
}

function flattenIssued(batchResult) {
  return (batchResult.results || []).reduce(function(rows, result) {
    return rows.concat(result.issued || []);
  }, []);
}

function mapPolicy(policy) {
  const source = policy || {};
  const starts = splitPolicyDateTime(source.claim_starts_at || source.claimStartsAt);
  const ends = splitPolicyDateTime(source.claim_ends_at || source.claimEndsAt);
  return {
    initialClaimEnabled: Boolean(source.initial_claim_enabled !== undefined
      ? source.initial_claim_enabled : source.initialClaimEnabled),
    allowRecoveryCode: Boolean(source.allow_recovery_code !== undefined
      ? source.allow_recovery_code : source.allowRecoveryCode),
    allowPassphrase: Boolean(source.allow_passphrase !== undefined
      ? source.allow_passphrase : source.allowPassphrase),
    claimStartsDate: starts.date,
    claimStartsTime: starts.time,
    claimEndsDate: ends.date,
    claimEndsTime: ends.time
  };
}

function freezeCredentialTargets(rows) {
  return Object.freeze((rows || []).map(function(row) {
    const auth = row && row.auth || {};
    return Object.freeze({
      hrId: String(row && row.id || ''),
      personId: String(row && row.personId || ''),
      accountId: String(row && row.accountId || ''),
      organizationId: String(row && row.organizationId || ''),
      name: String(row && row.name || localeCopy.copy_b04a71edad),
      pendingClaimId: String(auth.pendingClaimId || ''),
      hasActiveClaimCode: Boolean(auth.hasActiveClaimCode),
      hasActiveInvite: Boolean(auth.hasActiveInvite)
    });
  }));
}

module.exports = Behavior({
  data: {
    authPersonnelTabs: [],
    activeAuthPersonnelTab: '',
    authPersonnelLoading: false,
    authPersonnelLoaded: {},
    authActionLoadingKey: '',
    authSearch: '',
    authScopeOrganizationId: '',
    authScopeOrganizationName: '',
    authScopeOptions: [],
    authPendingClaims: [],
    authEligiblePeople: [],
    authRecoveryRequests: [],
    authAccounts: [],
    authPendingClaimTotal: 0,
    authEligiblePeopleTotal: 0,
    authRecoveryRequestTotal: 0,
    authAccountTotal: 0,
    selectedAuthClaimIds: [],
    selectedAuthEligiblePersonIds: [],
    selectedAuthAccountIds: [],
    selectedHrMemberIds: [],
    hrMemberSelectionCount: 0,
    hrFilteredSelectableCount: 0,
    hrCanSelectAll: false,
    hrCanInvertSelection: false,
    hrCanClearSelection: false,
    hrCanIssueVerification: false,
    hrCanRevokeVerification: false,
    hrCanIssueRecovery: false,
    hrCanRevokeRecovery: false,
    authPolicy: null,
    authPolicyLoading: false,
    authPolicyLoadFailed: false,
    authIssuedCodes: [],
    showAuthCodeDialog: false,
    showAuthRecoveryDialog: false,
    pendingAuthRecovery: null,
    authMemberConfirmVisible: false,
    authMemberConfirmAction: '',
    authMemberConfirmTitle: '',
    authMemberConfirmMessage: '',
    authMemberConfirmPersonId: '',
    authMemberConfirmHrId: '',
    authMemberConfirmName: '',
    authMemberConfirmFrozen: false,
    authMemberConfirmSessionId: '',
    authMemberConfirmActionLabel: '',
    detailHrSecurity: null,
    detailHrPassphraseInput: '',
    showDetailPassphraseForm: false
  },

  methods: {
    initializeAuthPersonnel() {
      const tabs = [];
      if (this.data.canManageAuthPolicy) tabs.push({ key: 'policy', label: localeCopy.copy_aef40f4a64 });
      const organizations = authContext.getOrganizations();
      const activeSession = orgSession.getSnapshot();
      const activeOrgId = activeSession.orgId || '';
      const activeOrgName = activeSession.orgName || '';
      const scopeOptions = this.data.isSuperAdmin
        ? [{ id: '', name: localeCopy.copy_d337157f74 }].concat(organizations)
        : [{ id: activeOrgId, name: activeOrgName || localeCopy.copy_2b8b8bf904 }];
      const currentTab = tabs.some((item) => item.key === this.data.activeAuthPersonnelTab)
        ? this.data.activeAuthPersonnelTab
        : (tabs[0] ? tabs[0].key : '');
      const currentScope = scopeOptions.find((item) => item.id === this.data.authScopeOrganizationId)
        || scopeOptions.find((item) => item.id === activeOrgId)
        || scopeOptions[0]
        || { id: activeOrgId, name: activeOrgName };
      this.setData({
        authPersonnelTabs: tabs,
        activeAuthPersonnelTab: currentTab,
        authScopeOptions: scopeOptions,
        authScopeOrganizationId: currentScope.id || '',
        authScopeOrganizationName: currentScope.name || '',
        authPersonnelLoaded: {}
      });
      return currentTab;
    },

    async loadHrGovernanceRows() {
      if (!this.data.canVerifyIdentity && !this.data.canRecoverAccounts && !this.data.canGlobalAccountManage) return new Map();
      const organizationId = orgSession.getSnapshot().orgId || '';
      const result = await callFunction({ name: 'listHrGovernance', data: { organizationId } });
      if (result.status !== 'success') throw new Error(result.message || localeCopy.copy_e58fa637eb);
      const selected = new Set(this.data.selectedHrMemberIds || []);
      const rows = (result.rows || []).map((item) => decorateGovernanceRow(item, selected.has(String(item.hrId || item.id || ''))));
      this._hrGovernanceRows = rows;
      this._hrGovernanceByHrId = new Map(rows.map((item) => [String(item.hrId || item.id || ''), item]));
      return this._hrGovernanceByHrId;
    },

    mergeHrGovernanceRows(profileRows, governanceByHrId) {
      const selected = new Set(this.data.selectedHrMemberIds || []);
      return (profileRows || []).map((row) => {
        const governance = governanceByHrId && governanceByHrId.get(String(row.id || ''));
        if (!governance) return this.applyHrGovernancePermissions(
          decorateGovernanceRow(row, selected.has(String(row.id || '')))
        );
        return this.applyHrGovernancePermissions(decorateGovernanceRow(Object.assign({}, row, governance, {
          id: row.id,
          hrId: row.id,
          name: row.name,
          studentId: row.studentId,
          membershipId: row.membershipId,
          membershipStatus: row.membershipStatus,
          joinedAt: row.joinedAt,
          leftAt: row.leftAt,
          assignments: row.assignments,
          assignmentNatures: row.assignmentNatures,
          departments: row.departments,
          identities: row.identities,
          workGroups: row.workGroups,
          assignmentCount: row.assignmentCount,
          auditStatus: row.auditStatus,
          auditStatusText: row.auditStatusText,
          isComplete: row.isComplete
        }), selected.has(String(row.id || ''))));
      });
    },

    applyHrGovernancePermissions(row) {
      const canSelect = Boolean(row && row.membershipStatus !== 'left' && (
        (this.data.canVerifyIdentity && (row.canIssueVerification || row.canRevokeVerification))
        || (this.data.canGlobalAccountManage && (row.canIssueRecovery || row.canRevokeRecovery))
      ));
      return Object.assign({}, row, { canSelectForAuth: canSelect });
    },

    buildHrMemberActionState(rows, selectedIds) {
      const visibleRows = Array.isArray(rows) ? rows : [];
      const selectableIds = new Set(visibleRows
        .filter((item) => item.canSelectForAuth)
        .map((item) => String(item.id || ''))
        .filter(Boolean));
      const selected = Array.from(new Set((selectedIds || this.data.selectedHrMemberIds || [])
        .map(String)
        .filter((id) => selectableIds.has(id))));
      const selectedSet = new Set(selected);
      const selectedRows = visibleRows.filter((item) => selectedSet.has(String(item.id || '')));
      return {
        selectedHrMemberIds: selected,
        hrMemberSelectionCount: selected.length,
        hrFilteredSelectableCount: selectableIds.size,
        hrCanSelectAll: selectableIds.size > 0 && selected.length < selectableIds.size,
        hrCanInvertSelection: selectableIds.size > 0,
        hrCanClearSelection: selected.length > 0,
        hrCanIssueVerification: selectedRows.some((item) => item.canIssueVerification),
        hrCanRevokeVerification: selectedRows.some((item) => item.canRevokeVerification),
        hrCanIssueRecovery: selectedRows.some((item) => item.canIssueRecovery),
        hrCanRevokeRecovery: selectedRows.some((item) => item.canRevokeRecovery)
      };
    },

    getHrGovernanceRow(hrId) {
      const target = String(hrId || this.data.detailHrId || '');
      if (!target) return null;
      return (this._hrProfileRawRows || []).find((item) => String(item.id || '') === target) || null;
    },

    toggleHrMemberSelection(e) {
      const hrId = String(e.currentTarget.dataset.hrId || '');
      if (!hrId) return;
      const row = this.getHrGovernanceRow(hrId);
      if (!row || !row.canSelectForAuth) return;
      const selected = new Set(this.data.selectedHrMemberIds || []);
      if (selected.has(hrId)) selected.delete(hrId); else selected.add(hrId);
      this.setData({ selectedHrMemberIds: Array.from(selected) });
      this.refreshHrMemberSelection();
    },

    selectAllFilteredHrMembers() {
      const ids = (this._hrProfileFilteredRows || [])
        .filter((item) => item.canSelectForAuth)
        .map((item) => String(item.id || ''))
        .filter(Boolean);
      this.setData({ selectedHrMemberIds: ids });
      this.refreshHrMemberSelection();
    },

    invertFilteredHrMembers() {
      const selected = new Set(this.data.selectedHrMemberIds || []);
      const ids = (this._hrProfileFilteredRows || [])
        .filter((item) => item.canSelectForAuth)
        .map((item) => String(item.id || ''))
        .filter(Boolean)
        .filter((id) => !selected.has(id));
      this.setData({ selectedHrMemberIds: ids });
      this.refreshHrMemberSelection();
    },

    clearHrMemberSelection() {
      this.setData({ selectedHrMemberIds: [] });
      this.refreshHrMemberSelection();
    },

    refreshHrMemberSelection() {
      const actionState = this.buildHrMemberActionState(
        this._hrProfileFilteredRows || [],
        this.data.selectedHrMemberIds || []
      );
      const selected = new Set(actionState.selectedHrMemberIds);
      const apply = (row) => Object.assign({}, row, { selected: selected.has(String(row.id || '')) });
      this._hrProfileRawRows = (this._hrProfileRawRows || []).map(apply);
      this._hrProfileFilteredRows = (this._hrProfileFilteredRows || []).map(apply);
      this.setData(Object.assign({}, actionState, {
        hrProfileRows: (this.data.hrProfileRows || []).map(apply)
      }));
    },

    getSelectedHrGovernanceRows() {
      const selected = new Set(this.data.selectedHrMemberIds || []);
      return (this._hrProfileFilteredRows || []).filter((item) => selected.has(String(item.id || '')));
    },

    patchHrGovernance(personId, patch, rowPatch) {
      this.patchHrGovernanceBatch([{ personId, patch, rowPatch }]);
    },

    patchHrGovernanceBatch(entries) {
      const patchByPerson = new Map();
      (entries || []).forEach((entry) => {
        const personId = String(entry && entry.personId || '');
        if (!personId) return;
        const previous = patchByPerson.get(personId) || { patch: {}, rowPatch: {} };
        patchByPerson.set(personId, {
          patch: Object.assign({}, previous.patch, entry.patch || {}),
          rowPatch: Object.assign({}, previous.rowPatch, entry.rowPatch || {})
        });
      });
      if (!patchByPerson.size) return;
      const apply = (row) => {
        const target = patchByPerson.get(String(row.personId || ''));
        if (!target) return row;
        return this.applyHrGovernancePermissions(decorateGovernanceRow(Object.assign({}, row, target.rowPatch, {
          auth: Object.assign({}, row.auth || {}, target.patch)
        }), row.selected));
      };
      this._hrProfileRawRows = (this._hrProfileRawRows || []).map(apply);
      this._hrProfileFilteredRows = (this._hrProfileFilteredRows || []).map(apply);
      const actionState = this.buildHrMemberActionState(
        this._hrProfileFilteredRows,
        this.data.selectedHrMemberIds || []
      );
      const detail = this.data.detailHrGovernance;
      const updates = Object.assign({}, actionState, {
        hrProfileRows: (this.data.hrProfileRows || []).map(apply)
      });
      if (detail && patchByPerson.has(String(detail.personId || ''))) {
        updates.detailHrGovernance = apply(detail);
      }
      this.setData(updates);
    },

    async issueHrMemberVerificationCode(e) {
      const hrId = String(e.currentTarget.dataset.hrId || '');
      const row = (this._hrProfileRawRows || []).find((item) => String(item.id || '') === hrId);
      if (!row || !row.personId || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'member-verify-' + hrId });
      try {
        let issued;
        if (row.auth && row.auth.pendingClaimId) {
          const result = await callFunction({ name: 'admin/auth/claims', data: {
            action: 'issue_code', claimId: row.auth.pendingClaimId
          } });
          if (result.status !== 'success' || !result.verificationCode) throw new Error(result.message || localeCopy.copy_9662ceba48);
          issued = { key: row.auth.pendingClaimId, personName: row.name, code: result.verificationCode };
          this.patchHrGovernance(row.personId, { hasActiveClaimCode: true });
        } else {
          const result = await callFunction({ name: 'admin/auth/claims', data: {
            action: 'issue_invites', personIds: [row.personId], organizationId: row.organizationId || orgSession.getSnapshot().orgId || ''
          } });
          const item = result.status === 'success' && result.issued && result.issued[0];
          if (!item || !item.code) throw new Error(result.message || localeCopy.copy_9662ceba48);
          issued = { key: item.inviteId || row.personId, personName: row.name, code: item.code };
          this.patchHrGovernance(row.personId, { hasActiveInvite: true });
        }
        this.setData({ authIssuedCodes: [issued], showAuthCodeDialog: true });
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async issueSelectedHrVerificationCodes() {
      const rows = this.getSelectedHrGovernanceRows().filter((item) => item.canIssueVerification);
      if (!rows.length || this.data.authActionLoadingKey) return;
      const claimRows = rows.filter((item) => item.auth && item.auth.pendingClaimId);
      const inviteRows = rows.filter((item) => item.personId && item.auth && !item.auth.pendingClaimId && !item.auth.hasBindingHistory);
      if (!claimRows.length && !inviteRows.length) return showShortToast(localeCopy.copy_0bc2266433);
      this.setData({ authActionLoadingKey: 'member-verify-batch' });
      try {
        const issued = [];
        const patches = [];
        if (claimRows.length) {
          const names = new Map(claimRows.map((item) => [item.auth.pendingClaimId, item]));
          const result = await runBatchedAuthAction({
            name: 'admin/auth/claims', action: 'issue_codes', idField: 'claimIds',
            ids: claimRows.map((item) => item.auth.pendingClaimId), batchSize: 50,
            failureMessage: localeCopy.copy_d7ceb7b422
          });
          flattenIssued(result).forEach((item) => {
            const row = names.get(item.claimId);
            if (row) {
              issued.push({ key: item.claimId, personName: row.name, code: item.verificationCode });
              patches.push({ personId: row.personId, patch: { hasActiveClaimCode: true } });
            }
          });
        }
        if (inviteRows.length) {
          const result = await runBatchedAuthAction({
            name: 'admin/auth/claims', action: 'issue_invites', idField: 'personIds',
            ids: inviteRows.map((item) => item.personId), batchSize: 100,
            failureMessage: localeCopy.copy_d7ceb7b422,
            extraData: { organizationId: orgSession.getSnapshot().orgId || '' }
          });
          const rowsByPerson = new Map(inviteRows.map((item) => [String(item.personId), item]));
          flattenIssued(result).forEach((item) => {
            const row = rowsByPerson.get(String(item.personId));
            if (row) {
              issued.push({ key: item.inviteId || item.personId, personName: row.name, code: item.code });
              patches.push({ personId: row.personId, patch: { hasActiveInvite: true } });
            }
          });
        }
        if (!issued.length) throw new Error(localeCopy.copy_9662ceba48);
        this.patchHrGovernanceBatch(patches);
        this.setData({ authIssuedCodes: issued, showAuthCodeDialog: true, selectedHrMemberIds: [] });
        this.refreshHrMemberSelection();
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    _openCredentialRevokeConfirm(kind, rows, isBatch) {
      const isVerification = kind === 'verification';
      if ((isVerification && !this.data.canVerifyIdentity)
        || (!isVerification && !this.data.canGlobalAccountManage)) return;
      const targets = freezeCredentialTargets(rows);
      if (!targets.length || this.data.authActionLoadingKey) return;
      this._authMemberConfirmPayload = Object.freeze({
        action: isVerification ? 'verification-code-revoke' : 'recovery-code-revoke',
        isBatch: Boolean(isBatch),
        targets
      });
      this.setData({
        authMemberConfirmVisible: true,
        authMemberConfirmAction: this._authMemberConfirmPayload.action,
        authMemberConfirmActionLabel: localeCopy.credentialRevokeAction,
        authMemberConfirmTitle: isVerification
          ? (isBatch ? localeCopy.verificationRevokeBatchTitle : localeCopy.verificationRevokeTitle)
          : (isBatch ? localeCopy.recoveryRevokeBatchTitle : localeCopy.recoveryRevokeTitle),
        authMemberConfirmMessage: isVerification
          ? localeCopy.verificationRevokeMessage
          : localeCopy.recoveryRevokeMessage,
        authMemberConfirmPersonId: '',
        authMemberConfirmHrId: '',
        authMemberConfirmName: isBatch
          ? localeCopy.credentialSelectedPrefix + targets.length + localeCopy.credentialSelectedSuffix
          : targets[0].name,
        authMemberConfirmFrozen: false,
        authMemberConfirmSessionId: ''
      });
    },

    revokeHrMemberVerificationCode(e) {
      if (!this.data.canVerifyIdentity) return;
      const hrId = String(e.currentTarget.dataset.hrId || '');
      const row = (this._hrProfileRawRows || []).find((item) => String(item.id || '') === hrId);
      if (!row || !row.personId || !row.canRevokeVerification || this.data.authActionLoadingKey) return;
      this._openCredentialRevokeConfirm('verification', [row], false);
    },

    async _revokeHrVerificationTargets(targets, isBatch) {
      if (!this.data.canVerifyIdentity || !targets || !targets.length || this.data.authActionLoadingKey) return;
      const loadingKey = isBatch ? 'member-verify-revoke-batch' : 'member-verify-revoke-' + targets[0].hrId;
      this.setData({ authActionLoadingKey: loadingKey });
      try {
        if (!isBatch) {
          const target = targets[0];
          const isClaimCode = Boolean(target.pendingClaimId && target.hasActiveClaimCode);
          const result = await callFunction({ name: 'admin/auth/claims', data: isClaimCode ? {
            action: 'revoke_codes', claimIds: [target.pendingClaimId]
          } : {
            action: 'revoke_invites', personIds: [target.personId], organizationId: target.organizationId || orgSession.getSnapshot().orgId || ''
          } });
          if (result.status !== 'success') throw new Error(result.message || localeCopy.copy_8351ecc192);
          this.patchHrGovernance(target.personId, isClaimCode
            ? { hasActiveClaimCode: false }
            : { hasActiveInvite: false });
          showShortToast(localeCopy.copy_8832186f8b, 'success');
          return;
        }
        const claimRows = targets.filter((item) => item.pendingClaimId && item.hasActiveClaimCode);
        const inviteRows = targets.filter((item) => item.personId && item.hasActiveInvite);
        const results = [];
        const patches = [];
        if (claimRows.length) {
          const result = await runBatchedAuthAction({
            name: 'admin/auth/claims', action: 'revoke_codes', idField: 'claimIds',
            ids: claimRows.map((item) => item.pendingClaimId), batchSize: 50,
            failureMessage: localeCopy.copy_e9798c95c0
          });
          results.push(result);
          const byClaim = new Map(claimRows.map((item) => [String(item.pendingClaimId), item]));
          result.completedIds.forEach((claimId) => {
            const target = byClaim.get(String(claimId));
            if (target) patches.push({ personId: target.personId, patch: { hasActiveClaimCode: false } });
          });
        }
        if (inviteRows.length) {
          const result = await runBatchedAuthAction({
            name: 'admin/auth/claims', action: 'revoke_invites', idField: 'personIds',
            ids: inviteRows.map((item) => item.personId), batchSize: 100,
            failureMessage: localeCopy.copy_e9798c95c0,
            extraData: { organizationId: orgSession.getSnapshot().orgId || '' }
          });
          results.push(result);
          const byPerson = new Map(inviteRows.map((item) => [String(item.personId), item]));
          result.completedIds.forEach((personId) => {
            const target = byPerson.get(String(personId));
            if (target) patches.push({ personId: target.personId, patch: { hasActiveInvite: false } });
          });
        }
        this.patchHrGovernanceBatch(patches);
        const failureCount = results.reduce((sum, result) => sum + result.failures.length, 0);
        this.setData({ selectedHrMemberIds: [] });
        this.refreshHrMemberSelection();
        showShortToast(failureCount ? localeCopy.copy_e9798c95c0 : localeCopy.copy_8832186f8b, failureCount ? 'none' : 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_8351ecc192));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    revokeSelectedHrVerificationCodes() {
      if (!this.data.canVerifyIdentity) return;
      const rows = this.getSelectedHrGovernanceRows().filter((item) => item.canRevokeVerification);
      if (!rows.length || this.data.authActionLoadingKey) return showShortToast(localeCopy.copy_f250d102a5);
      this._openCredentialRevokeConfirm('verification', rows, true);
    },

    async issueHrMemberRecoveryCode(e) {
      if (!this.data.canGlobalAccountManage) return;
      const hrId = String(e.currentTarget.dataset.hrId || '');
      const row = (this._hrProfileRawRows || []).find((item) => String(item.id || '') === hrId);
      if (!row || !row.accountId || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'member-recovery-' + hrId });
      try {
        const result = await callFunction({ name: 'admin/auth/recoveries', data: {
          action: 'issue_codes', accountIds: [row.accountId], organizationId: row.organizationId || orgSession.getSnapshot().orgId || ''
        } });
        const item = result.status === 'success' && result.issued && result.issued[0];
        if (!item || !item.code) throw new Error(result.message || localeCopy.copy_9662ceba48);
        this.patchHrGovernance(row.personId, { hasRecoveryCode: true });
        this.setData({ authIssuedCodes: [{ key: row.accountId, personName: row.name, code: item.code }], showAuthCodeDialog: true });
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async changeSelectedHrRecoveryCodes(revoke) {
      if (!this.data.canGlobalAccountManage) return;
      if (revoke) return this.revokeSelectedHrRecoveryCodes();
      const rows = this.getSelectedHrGovernanceRows().filter((item) => (
        item.canIssueRecovery
      ));
      if (!rows.length || this.data.authActionLoadingKey) return showShortToast(localeCopy.copy_3947b0ede8);
      this.setData({ authActionLoadingKey: 'member-recovery-batch' });
      try {
        const result = await runBatchedAuthAction({
          name: 'admin/auth/recoveries', action: 'issue_codes', idField: 'accountIds',
          ids: rows.map((item) => item.accountId), batchSize: 100,
          failureMessage: localeCopy.copy_e5392c8b50,
          extraData: { organizationId: orgSession.getSnapshot().orgId || '' }
        });
        const byAccount = new Map(rows.map((item) => [String(item.accountId), item]));
        const patches = [];
        const issued = flattenIssued(result).map((item) => {
          const row = byAccount.get(String(item.accountId));
          if (row) patches.push({ personId: row.personId, patch: { hasRecoveryCode: true } });
          return { key: item.accountId, personName: item.name || row && row.name || localeCopy.copy_6e1cafa10a, code: item.code };
        });
        if (!issued.length) throw new Error(localeCopy.copy_9662ceba48);
        this.setData({ authIssuedCodes: issued, showAuthCodeDialog: true });
        this.patchHrGovernanceBatch(patches);
        this.setData({ selectedHrMemberIds: [] });
        this.refreshHrMemberSelection();
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    issueSelectedHrRecoveryCodes() {
      return this.changeSelectedHrRecoveryCodes(false);
    },

    revokeSelectedHrRecoveryCodes() {
      if (!this.data.canGlobalAccountManage) return;
      const rows = this.getSelectedHrGovernanceRows().filter((item) => item.canRevokeRecovery);
      if (!rows.length || this.data.authActionLoadingKey) return showShortToast(localeCopy.copy_3947b0ede8);
      this._openCredentialRevokeConfirm('recovery', rows, true);
    },

    revokeHrMemberRecoveryCode(e) {
      if (!this.data.canGlobalAccountManage) return;
      const hrId = String(e.currentTarget.dataset.hrId || '');
      const row = (this._hrProfileRawRows || []).find((item) => String(item.id || '') === hrId);
      if (!row || !row.accountId || !row.canRevokeRecovery || this.data.authActionLoadingKey) return;
      this._openCredentialRevokeConfirm('recovery', [row], false);
    },

    async _revokeHrRecoveryTargets(targets, isBatch) {
      if (!this.data.canGlobalAccountManage || !targets || !targets.length || this.data.authActionLoadingKey) return;
      const loadingKey = isBatch ? 'member-recovery-revoke' : 'member-recovery-revoke-' + targets[0].hrId;
      this.setData({ authActionLoadingKey: loadingKey });
      try {
        if (!isBatch) {
          const target = targets[0];
          const result = await callFunction({ name: 'admin/auth/recoveries', data: {
            action: 'revoke_codes',
            accountIds: [target.accountId],
            organizationId: target.organizationId || orgSession.getSnapshot().orgId || ''
          } });
          if (result.status !== 'success') throw new Error(result.message || localeCopy.copy_8351ecc192);
          this.patchHrGovernance(target.personId, { hasRecoveryCode: false });
          showShortToast(localeCopy.copy_42e9898395, 'success');
          return;
        }
        const result = await runBatchedAuthAction({
          name: 'admin/auth/recoveries', action: 'revoke_codes', idField: 'accountIds',
          ids: targets.map((item) => item.accountId), batchSize: 100,
          failureMessage: localeCopy.copy_5254a703ec,
          extraData: { organizationId: orgSession.getSnapshot().orgId || '' }
        });
        const byAccount = new Map(targets.map((item) => [String(item.accountId), item]));
        const patches = [];
        result.completedIds.forEach((id) => {
          const target = byAccount.get(String(id));
          if (target) patches.push({ personId: target.personId, patch: { hasRecoveryCode: false } });
        });
        this.patchHrGovernanceBatch(patches);
        this.setData({ selectedHrMemberIds: [] });
        this.refreshHrMemberSelection();
        showShortToast(result.failures.length ? localeCopy.copy_5254a703ec : localeCopy.copy_42e9898395, result.failures.length ? 'none' : 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_8351ecc192));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    switchAuthPersonnelTab(e) {
      const key = String(e.currentTarget.dataset.key || '');
      if (!key || key === this.data.activeAuthPersonnelTab) return;
      this.setData({ activeAuthPersonnelTab: key, authSearch: '' });
      this.loadAuthPersonnel();
    },

    onAuthScopeChange(e) {
      const option = this.data.authScopeOptions[Number(e.detail.value || 0)];
      if (!option || option.id === this.data.authScopeOrganizationId) return;
      this._authPendingClaimsRaw = [];
      this._authEligiblePeopleRaw = [];
      this._authRecoveryRequestsRaw = [];
      this._authAccountsRaw = [];
      this.setData({
        authScopeOrganizationId: option.id || '',
        authScopeOrganizationName: option.name || '',
        authPersonnelLoaded: {},
        authSearch: '',
        authPendingClaimTotal: 0,
        authEligiblePeopleTotal: 0,
        authRecoveryRequestTotal: 0,
        authAccountTotal: 0,
        selectedAuthClaimIds: [],
        selectedAuthEligiblePersonIds: [],
        selectedAuthAccountIds: []
      });
      this.loadAuthPersonnel(true);
    },

    onAuthSearchInput(e) {
      const authSearch = String(e.detail.value || '').trim();
      this.setData({ authSearch });
      this.applyAuthPersonnelFilter(authSearch);
    },

    clearAuthSearch() {
      this.setData({ authSearch: '' });
      this.applyAuthPersonnelFilter('');
    },

    applyAuthPersonnelFilter(keyword) {
      const selectedClaims = new Set(this.data.selectedAuthClaimIds || []);
      const selectedEligible = new Set(this.data.selectedAuthEligiblePersonIds || []);
      const selectedAccounts = new Set(this.data.selectedAuthAccountIds || []);
      this.setData({
        authPendingClaims: (this._authPendingClaimsRaw || []).filter((item) => matchesKeyword(item, keyword))
          .map((item) => Object.assign({}, item, { selected: selectedClaims.has(item.id) })),
        authEligiblePeople: (this._authEligiblePeopleRaw || []).filter((item) => matchesKeyword(item, keyword))
          .map((item) => Object.assign({}, item, { selected: selectedEligible.has(item.personId) })),
        authRecoveryRequests: (this._authRecoveryRequestsRaw || []).filter((item) => matchesKeyword(item, keyword)),
        authAccounts: (this._authAccountsRaw || []).filter((item) => matchesKeyword(item, keyword))
          .map((item) => Object.assign({}, item, { selected: selectedAccounts.has(item.accountId) }))
      });
    },

    async loadAuthPersonnel(force, tabOverride) {
      const tab = tabOverride || this.data.activeAuthPersonnelTab;
      if (!tab || this.data.authPersonnelLoading) return;
      if (!force && this.data.authPersonnelLoaded[tab]) {
        this.applyAuthPersonnelFilter(this.data.authSearch);
        return;
      }
      const request = orgSession.beginRequest(this, 'authPersonnel-' + tab);
      this.setData({ authPersonnelLoading: true });
      try {
        if (tab === 'onboarding') await this.loadAuthOnboarding();
        if (tab === 'accounts') await this.loadAuthAccounts();
        if (tab === 'policy') await this.loadAuthPolicy();
        if (!orgSession.isRequestCurrent(this, request)) return;
        this.setData({
          authPersonnelLoaded: Object.assign({}, this.data.authPersonnelLoaded, { [tab]: true })
        });
        this.applyAuthPersonnelFilter(this.data.authSearch);
      } catch (error) {
        if (!orgSession.isRequestCurrent(this, request)) return;
        showShortToast(getErrorText(error, localeCopy.copy_e58fa637eb));
      } finally {
        if (orgSession.isRequestCurrent(this, request)) this.setData({ authPersonnelLoading: false });
      }
    },

    async loadAuthOnboarding() {
      const organizationId = this.data.authScopeOrganizationId;
      const governanceResult = await callFunction({ name: 'listHrGovernance', data: { organizationId } });
      const results = await Promise.all([
        callFunction({ name: 'admin/auth/claims', data: {
          action: 'list', limit: DIRECTORY_LIMIT, organizationId
        } })
      ]);
      if (results[0].status !== 'success' || governanceResult.status !== 'success') {
        throw new Error(results[0].message || localeCopy.copy_e58fa637eb);
      }
      this._authPendingClaimsRaw = (results[0].list || []).map(decorateClaim);
      this._authEligiblePeopleRaw = uniquePeople((governanceResult.rows || [])
        .filter((item) => item.auth && !item.auth.hasBindingHistory)
        .map((item) => Object.assign({}, item, {
          hasActiveInvite: Boolean(item.auth.hasActiveInvite),
          selected: false
        })));
      this.setData({
        authPendingClaimTotal: this._authPendingClaimsRaw.length,
        authEligiblePeopleTotal: this._authEligiblePeopleRaw.length,
        selectedAuthClaimIds: [],
        selectedAuthEligiblePersonIds: []
      });
    },

    async loadAuthAccounts() {
      const organizationId = this.data.authScopeOrganizationId;
      const governanceResult = await callFunction({ name: 'listHrGovernance', data: { organizationId } });
      const results = await Promise.all([
        callFunction({ name: 'admin/auth/recoveries', data: {
          action: 'list', limit: DIRECTORY_LIMIT, organizationId
        } }),
        callFunction({ name: 'admin/auth/accounts', data: {
          action: 'list', limit: DIRECTORY_LIMIT, organizationId
        } })
      ]);
      if (results[0].status !== 'success' || results[1].status !== 'success' || governanceResult.status !== 'success') {
        throw new Error(results[0].message || results[1].message || localeCopy.copy_e58fa637eb);
      }
      this._authRecoveryRequestsRaw = (results[0].list || []).map(decorateClaim);
      const legacyByPerson = new Map((results[1].list || []).map((item) => [String(item.personId || ''), item]));
      this._authAccountsRaw = (governanceResult.rows || []).filter((item) => item.accountId).map((item) => {
        const legacy = legacyByPerson.get(String(item.personId || '')) || {};
        const auth = item.auth || {};
        return decorateAccount(Object.assign({}, legacy, item, {
          accountId: item.accountId || legacy.accountId,
          accountStatus: auth.status || legacy.accountStatus,
          hasRecoveryCode: Boolean(auth.hasRecoveryCode),
          activeSessionCount: Number(auth.activeSessionCount || legacy.activeSessionCount || 0),
          hasPendingClaim: Boolean(auth.hasPendingClaim || legacy.hasPendingClaim),
          hasActiveInvite: Boolean(auth.hasActiveInvite || legacy.hasActiveInvite)
        }));
      });
      this.setData({
        authRecoveryRequestTotal: this._authRecoveryRequestsRaw.length,
        authAccountTotal: this._authAccountsRaw.length,
        selectedAuthAccountIds: []
      });
    },

    async loadAuthPolicy() {
      if (this.data.authPolicyLoading) return;
      this.setData({ authPolicyLoading: true, authPolicyLoadFailed: false });
      try {
        const result = await callFunction({ name: 'admin/auth/policy', data: { action: 'get' } });
        if (result.status !== 'success') throw new Error(result.message || localeCopy.copy_e58fa637eb);
        this.setData({ authPolicy: mapPolicy(result.policy), authPolicyLoadFailed: false });
      } catch (error) {
        this.setData({ authPolicyLoadFailed: true });
        throw error;
      } finally {
        this.setData({ authPolicyLoading: false });
      }
    },

    retryAuthPolicy() {
      this.loadAuthPolicy().catch(() => {
        showShortToast(localeCopy.copy_439c4fcf37);
      });
    },

    toggleAuthClaimSelection(e) {
      const id = String(e.currentTarget.dataset.id || '');
      const selected = new Set(this.data.selectedAuthClaimIds || []);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      this.setData({ selectedAuthClaimIds: Array.from(selected) });
      this.applyAuthPersonnelFilter(this.data.authSearch);
    },

    toggleAuthEligibleSelection(e) {
      const id = String(e.currentTarget.dataset.id || '');
      const selected = new Set(this.data.selectedAuthEligiblePersonIds || []);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      this.setData({ selectedAuthEligiblePersonIds: Array.from(selected) });
      this.applyAuthPersonnelFilter(this.data.authSearch);
    },

    toggleAuthAccountSelection(e) {
      const id = String(e.currentTarget.dataset.id || '');
      const selected = new Set(this.data.selectedAuthAccountIds || []);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      this.setData({ selectedAuthAccountIds: Array.from(selected) });
      this.applyAuthPersonnelFilter(this.data.authSearch);
    },

    selectAllVisibleAuthClaims() {
      this.setData({ selectedAuthClaimIds: this.data.authPendingClaims.map((item) => item.id) });
      this.applyAuthPersonnelFilter(this.data.authSearch);
    },

    selectAllVisibleAuthEligible() {
      this.setData({ selectedAuthEligiblePersonIds: this.data.authEligiblePeople.map((item) => item.personId) });
      this.applyAuthPersonnelFilter(this.data.authSearch);
    },

    selectAllVisibleAuthAccounts() {
      const accountIds = this.data.authAccounts
        .filter((item) => item.accountStatus !== 'frozen')
        .map((item) => item.accountId);
      this.setData({ selectedAuthAccountIds: accountIds });
      this.applyAuthPersonnelFilter(this.data.authSearch);
    },

    clearAuthSelection() {
      this.setData({
        selectedAuthClaimIds: [],
        selectedAuthEligiblePersonIds: [],
        selectedAuthAccountIds: []
      });
      this.applyAuthPersonnelFilter(this.data.authSearch);
    },

    async issueAuthClaimCode(e) {
      const claimId = String(e.currentTarget.dataset.id || '');
      const name = String(e.currentTarget.dataset.name || '');
      if (!claimId || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'claim-' + claimId });
      try {
        const result = await callFunction({ name: 'admin/auth/claims', data: {
          action: 'issue_code', claimId
        } });
        if (result.status !== 'success' || !result.verificationCode) {
          throw new Error(result.message || localeCopy.copy_9662ceba48);
        }
        this._authPendingClaimsRaw = (this._authPendingClaimsRaw || []).map((item) =>
          item.id === claimId ? Object.assign({}, item, { hasActiveCode: true }) : item);
        this.setData({
          authIssuedCodes: [{ key: claimId, personName: name, code: result.verificationCode }],
          showAuthCodeDialog: true
        });
        this.applyAuthPersonnelFilter(this.data.authSearch);
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async issueSelectedAuthClaimCodes() {
      const ids = this.data.selectedAuthClaimIds || [];
      if (!ids.length || this.data.authActionLoadingKey) return;
      const names = {};
      (this._authPendingClaimsRaw || []).forEach((item) => { names[item.id] = item.name; });
      this.setData({ authActionLoadingKey: 'claim-batch' });
      try {
        const batchResult = await runBatchedAuthAction({
          name: 'admin/auth/claims', action: 'issue_codes', idField: 'claimIds',
          ids, batchSize: 50, failureMessage: localeCopy.copy_9662ceba48
        });
        const issued = flattenIssued(batchResult).map((item) => ({
          key: item.claimId,
          personName: names[item.claimId] || localeCopy.copy_87e91ac4b4,
          code: item.verificationCode
        }));
        const selected = new Set(issued.map((item) => item.key));
        this._authPendingClaimsRaw = (this._authPendingClaimsRaw || []).map((item) =>
          selected.has(item.id) ? Object.assign({}, item, { hasActiveCode: true }) : item);
        this.setData({ authIssuedCodes: issued, showAuthCodeDialog: true, selectedAuthClaimIds: [] });
        this.applyAuthPersonnelFilter(this.data.authSearch);
        if (batchResult.failures.length) showShortToast(localeCopy.copy_35ca909941);
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async issueSelectedInitialCodes() {
      const ids = this.data.selectedAuthEligiblePersonIds || [];
      if (!ids.length || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'invite-batch' });
      try {
        const batchResult = await runBatchedAuthAction({
          name: 'admin/auth/claims', action: 'issue_invites', idField: 'personIds',
          ids, batchSize: 100, failureMessage: localeCopy.copy_9662ceba48,
          extraData: { organizationId: this.data.authScopeOrganizationId }
        });
        const issued = flattenIssued(batchResult).map((item) => ({
          key: item.inviteId || item.personId,
          personId: item.personId,
          personName: item.name,
          code: item.code
        }));
        const selected = new Set(issued.map((item) => item.personId));
        this._authEligiblePeopleRaw = (this._authEligiblePeopleRaw || []).map((item) =>
          selected.has(item.personId) ? Object.assign({}, item, { hasActiveInvite: true }) : item);
        this.setData({ authIssuedCodes: issued, showAuthCodeDialog: true, selectedAuthEligiblePersonIds: [] });
        this.applyAuthPersonnelFilter(this.data.authSearch);
        if (batchResult.failures.length) showShortToast(localeCopy.copy_35ca909941);
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async revokeSelectedInitialCodes() {
      const ids = this.data.selectedAuthEligiblePersonIds || [];
      if (!ids.length || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'invite-revoke' });
      try {
        const batchResult = await runBatchedAuthAction({
          name: 'admin/auth/claims', action: 'revoke_invites', idField: 'personIds',
          ids, batchSize: 100, failureMessage: localeCopy.copy_8351ecc192,
          extraData: { organizationId: this.data.authScopeOrganizationId }
        });
        const selected = new Set(batchResult.completedIds);
        this._authEligiblePeopleRaw = (this._authEligiblePeopleRaw || []).map((item) =>
          selected.has(item.personId) ? Object.assign({}, item, { hasActiveInvite: false }) : item);
        this.setData({ selectedAuthEligiblePersonIds: [] });
        this.applyAuthPersonnelFilter(this.data.authSearch);
        showShortToast(batchResult.failures.length ? localeCopy.copy_fe17a0abf0 : localeCopy.copy_4b5b472953,
          batchResult.failures.length ? 'none' : 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_8351ecc192));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    openAuthRecoveryDialog(e) {
      if (!this.data.canGlobalAccountManage) return;
      const id = String(e.currentTarget.dataset.id || '');
      const pending = (this._authRecoveryRequestsRaw || []).find((item) => item.id === id)
        || (() => {
          const row = (this._hrProfileRawRows || []).find((item) => item.auth && item.auth.pendingRecoveryId === id);
          return row ? Object.assign({}, row, { id }) : null;
        })();
      if (pending) this.setData({ showAuthRecoveryDialog: true, pendingAuthRecovery: pending });
    },

    closeAuthRecoveryDialog() {
      if (this.data.authActionLoadingKey) return;
      this.setData({ showAuthRecoveryDialog: false, pendingAuthRecovery: null });
    },

    async loadDetailHrSecurity(personId, detailRequestId) {
      if (!this.data.canGlobalAccountManage) return;
      if (!personId || this.data.authActionLoadingKey) return;
      const expectedPersonId = String(personId);
      const expectedRequestId = Number(detailRequestId || this._hrPersonDetailRequestId || 0);
      try {
        const result = await callFunction({ name: 'admin/auth/security', data: { personId } });
        const currentGovernance = this.data.detailHrGovernance || {};
        if (Number(this._hrPersonDetailRequestId || 0) !== expectedRequestId
          || String(currentGovernance.personId || '') !== expectedPersonId
          || !this.data.showHrPersonDetail) return;
        if (!result || result.status !== 'success') {
          this.setData({ detailHrSecurity: null });
          return;
        }
        const sessions = (result.sessions || []).map(function(item) {
          return Object.assign({}, item, {
            lastSeenText: item.lastSeenAt
              ? formatAuditDetailTime(item.lastSeenAt, item.lastSeenAtReviewStatus)
              : localeCopy.copy_cb56cac0f1
          });
        });
        this.setData({
          detailHrSecurity: {
            account: result.account || null,
            accountExists: Boolean(result.accountExists),
            bindingStatus: result.bindingStatus || '',
            passphraseSet: Boolean(result.passphraseSet),
            sessions
          }
        });
      } catch (error) {
        const currentGovernance = this.data.detailHrGovernance || {};
        if (Number(this._hrPersonDetailRequestId || 0) !== expectedRequestId
          || String(currentGovernance.personId || '') !== expectedPersonId
          || !this.data.showHrPersonDetail) return;
        this.setData({ detailHrSecurity: null });
      }
    },

    toggleDetailPassphraseForm() {
      if (!this.data.canGlobalAccountManage) return;
      this.setData({
        showDetailPassphraseForm: !this.data.showDetailPassphraseForm,
        detailHrPassphraseInput: ''
      });
    },

    onDetailPassphraseInput(e) {
      if (!this.data.canGlobalAccountManage) return;
      this.setData({ detailHrPassphraseInput: String(e.detail.value || '') });
    },

    async saveDetailMemberPassphrase() {
      if (!this.data.canGlobalAccountManage) return;
      const security = this.data.detailHrSecurity;
      const value = this.data.detailHrPassphraseInput;
      const personId = String(this.data.detailHrGovernance && this.data.detailHrGovernance.personId || '');
      if (!security || !personId || this.data.authActionLoadingKey) return;
      if (!value) {
        showShortToast(localeCopy.copy_65d888be46);
        return;
      }
      this.setData({ authActionLoadingKey: 'member-passphrase-save' });
      try {
        const result = await callFunction({ name: 'admin/auth/security/passphrase', data: { personId, value } });
        if (!result || result.status !== 'success') {
          throw new Error((result && result.message) || localeCopy.copy_215e3c57da);
        }
        this.setData({
          showDetailPassphraseForm: false,
          detailHrPassphraseInput: '',
          'detailHrSecurity.accountExists': true,
          'detailHrSecurity.passphraseSet': true,
          'detailHrGovernance.accountId': String(result.accountId || this.data.detailHrGovernance.accountId || ''),
          'detailHrGovernance.auth.status': this.data.detailHrGovernance.auth.status || 'verified'
        });
        showShortToast(localeCopy.copy_cd01c4669c, 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_215e3c57da));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    requestMemberDeviceRevoke(e) {
      if (!this.data.canGlobalAccountManage) return;
      const sessionId = String(e.currentTarget.dataset.sessionId || '');
      const security = this.data.detailHrSecurity;
      const row = this.getHrGovernanceRow(this.data.detailHrId);
      if (!sessionId || !security || !row || this.data.authActionLoadingKey) return;
      const session = (security.sessions || []).find(function(item) { return item.id === sessionId; });
      this.setData({
        authMemberConfirmVisible: true,
        authMemberConfirmAction: 'device-revoke',
        authMemberConfirmActionLabel: localeCopy.copy_c3f53dd501,
        authMemberConfirmTitle: localeCopy.copy_78b51a10ec,
        authMemberConfirmMessage: localeCopy.copy_69d8cb0e31 + String(session && session.deviceLabel || localeCopy.copy_e169da88b9),
        authMemberConfirmPersonId: String(row.personId || ''),
        authMemberConfirmHrId: String(this.data.detailHrId || ''),
        authMemberConfirmName: String(row.name || localeCopy.copy_b04a71edad),
        authMemberConfirmSessionId: sessionId,
        authMemberConfirmFrozen: false
      });
    },

    requestMemberPassphraseClear() {
      if (!this.data.canGlobalAccountManage) return;
      const row = this.getHrGovernanceRow(this.data.detailHrId);
      if (!row || !this.data.detailHrSecurity || this.data.authActionLoadingKey) return;
      this.setData({
        authMemberConfirmVisible: true,
        authMemberConfirmAction: 'passphrase-clear',
        authMemberConfirmActionLabel: localeCopy.copy_5cde2d7c64,
        authMemberConfirmTitle: localeCopy.copy_f8990cda8e,
        authMemberConfirmMessage: localeCopy.copy_6eb4c651be,
        authMemberConfirmPersonId: String(row.personId || ''),
        authMemberConfirmHrId: String(this.data.detailHrId || ''),
        authMemberConfirmName: String(row.name || localeCopy.copy_b04a71edad),
        authMemberConfirmSessionId: '',
        authMemberConfirmFrozen: false
      });
    },

    async revokeMemberDevice(sessionId) {
      if (!this.data.canGlobalAccountManage) return;
      const row = this.getHrGovernanceRow(this.data.detailHrId);
      const personId = String(row && row.personId || '');
      if (!sessionId || !personId || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'member-device-revoke' });
      try {
        const result = await callFunction({
          name: 'admin/auth/security/sessions/revoke',
          data: { personId, sessionId }
        });
        if (!result || result.status !== 'success') {
          throw new Error((result && result.message) || localeCopy.copy_bff49f783f);
        }
        this.setData({
          'detailHrSecurity.sessions': (this.data.detailHrSecurity.sessions || []).filter(function(item) { return item.id !== sessionId; }),
          'detailHrGovernance.auth.activeSessionCount': Math.max(Number(this.data.detailHrGovernance.auth.activeSessionCount || 0) - 1, 0)
        });
        showShortToast(localeCopy.copy_c69999ba88, 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_bff49f783f));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async clearMemberPassphrase() {
      if (!this.data.canGlobalAccountManage) return;
      const row = this.getHrGovernanceRow(this.data.detailHrId);
      const personId = String(row && row.personId || '');
      if (!personId || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'member-passphrase-clear' });
      try {
        const result = await callFunction({ name: 'admin/auth/security/passphrase/revoke', data: { personId } });
        if (!result || result.status !== 'success') {
          throw new Error((result && result.message) || localeCopy.copy_bff49f783f);
        }
        this.setData({ 'detailHrSecurity.passphraseSet': false });
        showShortToast(localeCopy.copy_8986ce443d, 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_bff49f783f));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    requestAuthAccountFreeze(e) {
      if (!this.data.canGlobalAccountManage) return;
      const personId = String(e.currentTarget.dataset.id || '');
      const frozen = e.currentTarget.dataset.frozen === true
        || e.currentTarget.dataset.frozen === 'true';
      if (!personId || this.data.authActionLoadingKey) return;
      if (frozen) {
        this.toggleAuthAccountFrozen(e);
        return;
      }
      const row = this.getHrGovernanceRow(e.currentTarget.dataset.hrId);
      this.setData({
        authMemberConfirmVisible: true,
        authMemberConfirmAction: 'freeze',
        authMemberConfirmActionLabel: localeCopy.copy_b88a1260e3,
        authMemberConfirmTitle: localeCopy.copy_eb1ebe5d11,
        authMemberConfirmMessage: localeCopy.copy_8724ac4ea3,
        authMemberConfirmPersonId: personId,
        authMemberConfirmHrId: String(e.currentTarget.dataset.hrId || ''),
        authMemberConfirmName: String(row && row.name || localeCopy.copy_b04a71edad),
        authMemberConfirmFrozen: false
      });
    },

    requestHrWechatUnbind(e) {
      if (!this.data.canGlobalAccountManage) return;
      const hrId = String(e.currentTarget.dataset.hrId || this.data.detailHrId || '');
      const row = this.getHrGovernanceRow(hrId);
      if (!row || !row.canUnbindWechat || this.data.authActionLoadingKey) return;
      this.setData({
        authMemberConfirmVisible: true,
        authMemberConfirmAction: 'unbind',
        authMemberConfirmActionLabel: localeCopy.copy_b86e259dd7,
        authMemberConfirmTitle: localeCopy.copy_71962e6b30,
        authMemberConfirmMessage: localeCopy.copy_4c2f44d390,
        authMemberConfirmPersonId: String(row.personId || ''),
        authMemberConfirmHrId: hrId,
        authMemberConfirmName: String(row.name || localeCopy.copy_b04a71edad),
        authMemberConfirmFrozen: false
      });
    },

    closeAuthMemberConfirm() {
      if (this.data.authActionLoadingKey) return;
      this._authMemberConfirmPayload = null;
      this.setData({
        authMemberConfirmVisible: false,
        authMemberConfirmAction: '',
        authMemberConfirmActionLabel: '',
        authMemberConfirmTitle: '',
        authMemberConfirmMessage: '',
        authMemberConfirmPersonId: '',
        authMemberConfirmHrId: '',
        authMemberConfirmName: '',
        authMemberConfirmFrozen: false,
        authMemberConfirmSessionId: ''
      });
    },

    confirmAuthMemberAction() {
      const action = this.data.authMemberConfirmAction;
      const personId = this.data.authMemberConfirmPersonId;
      const hrId = this.data.authMemberConfirmHrId;
      if (!action || this.data.authActionLoadingKey) return;
      const payload = this._authMemberConfirmPayload;
      if (action === 'verification-code-revoke') {
        if (!this.data.canVerifyIdentity || !payload || payload.action !== action) return;
      } else if (action === 'recovery-code-revoke') {
        if (!this.data.canGlobalAccountManage || !payload || payload.action !== action) return;
      }
      this._authMemberConfirmPayload = null;
      this.setData({ authMemberConfirmVisible: false });
      if (action === 'freeze') {
        this.toggleAuthAccountFrozen({
          currentTarget: { dataset: { id: personId, hrId, frozen: false } }
        });
      } else if (action === 'unbind') {
        this.unbindHrWechat({ currentTarget: { dataset: { hrId } } });
      } else if (action === 'device-revoke') {
        this.revokeMemberDevice(this.data.authMemberConfirmSessionId);
      } else if (action === 'passphrase-clear') {
        this.clearMemberPassphrase();
      } else if (action === 'verification-code-revoke') {
        this._revokeHrVerificationTargets(payload.targets, payload.isBatch);
      } else if (action === 'recovery-code-revoke') {
        this._revokeHrRecoveryTargets(payload.targets, payload.isBatch);
      }
    },

    async approveAuthRecovery() {
      if (!this.data.canGlobalAccountManage) return;
      const pending = this.data.pendingAuthRecovery;
      if (!pending || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'recovery-' + pending.id });
      try {
        const result = await callFunction({ name: 'admin/auth/recoveries', data: {
          action: 'approve', recoveryRequestId: pending.id
        } });
        if (result.status !== 'success') throw new Error(result.message || localeCopy.copy_0531ed9e78);
        this._authRecoveryRequestsRaw = (this._authRecoveryRequestsRaw || [])
          .filter((item) => item.id !== pending.id);
        this.patchHrGovernance(pending.personId, {
          pendingRecoveryId: '',
          status: 'verified',
          hasActiveBinding: true,
          activeSessionCount: 0
        }, { wxBindStatus: 'bound' });
        this.setData({ showAuthRecoveryDialog: false, pendingAuthRecovery: null });
        this.applyAuthPersonnelFilter(this.data.authSearch);
        showShortToast(localeCopy.copy_dc71c071bc, 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_0531ed9e78));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async toggleAuthAccountFrozen(e) {
      if (!this.data.canGlobalAccountManage) return;
      const personId = String(e.currentTarget.dataset.id || '');
      const frozen = e.currentTarget.dataset.frozen === true
        || e.currentTarget.dataset.frozen === 'true';
      if (!personId || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'freeze-' + personId });
      try {
        const result = await callFunction({ name: 'admin/auth/accounts', data: {
          action: frozen ? 'unfreeze' : 'freeze', personId
        } });
        if (result.status !== 'success') throw new Error(result.message || localeCopy.copy_89be75a701);
        const nextStatus = result.accountStatus || (frozen ? 'verified' : 'frozen');
        const rawIndex = (this._authAccountsRaw || []).findIndex((item) => item.personId === personId);
        const currentRow = rawIndex >= 0 ? this._authAccountsRaw[rawIndex] : null;
        const nextRow = currentRow ? decorateAccount(Object.assign({}, currentRow, {
          accountStatus: nextStatus
        })) : null;
        if (rawIndex >= 0 && nextRow) this._authAccountsRaw[rawIndex] = nextRow;
        const visibleIndex = (this.data.authAccounts || []).findIndex((item) => item.personId === personId);
        const updates = {};
        if (visibleIndex >= 0 && nextRow) updates['authAccounts[' + visibleIndex + ']'] = nextRow;
        if (nextStatus === 'frozen') {
          updates.selectedAuthAccountIds = (this.data.selectedAuthAccountIds || [])
            .filter((accountId) => accountId !== (currentRow && currentRow.accountId));
        }
        if (Object.keys(updates).length) this.setData(updates);
        this.patchHrGovernance(personId, nextStatus === 'frozen'
          ? { status: nextStatus, activeSessionCount: 0 }
          : { status: nextStatus });
        showShortToast(frozen ? localeCopy.copy_5b583a7975 : localeCopy.copy_4defd9babd, 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_89be75a701));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async issueSelectedRecoveryCodes() {
      if (!this.data.canGlobalAccountManage) return;
      const ids = this.data.selectedAuthAccountIds || [];
      if (!ids.length || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'recovery-code' });
      try {
        const batchResult = await runBatchedAuthAction({
          name: 'admin/auth/recoveries', action: 'issue_codes', idField: 'accountIds',
          ids, batchSize: 100, failureMessage: localeCopy.copy_9662ceba48,
          extraData: { organizationId: this.data.authScopeOrganizationId }
        });
        const issued = flattenIssued(batchResult).map((item) => ({
          key: item.accountId,
          personName: item.name,
          code: item.code
        }));
        const selected = new Set(issued.map((item) => item.key));
        this._authAccountsRaw = (this._authAccountsRaw || []).map((item) =>
          selected.has(item.accountId) ? Object.assign({}, item, { hasRecoveryCode: true }) : item);
        this.setData({ authIssuedCodes: issued, showAuthCodeDialog: true, selectedAuthAccountIds: [] });
        this.applyAuthPersonnelFilter(this.data.authSearch);
        if (batchResult.failures.length) showShortToast(localeCopy.copy_35ca909941);
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_9662ceba48));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    async revokeSelectedRecoveryCodes() {
      if (!this.data.canGlobalAccountManage) return;
      const ids = this.data.selectedAuthAccountIds || [];
      if (!ids.length || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'recovery-code-revoke' });
      try {
        const batchResult = await runBatchedAuthAction({
          name: 'admin/auth/recoveries', action: 'revoke_codes', idField: 'accountIds',
          ids, batchSize: 100, failureMessage: localeCopy.copy_8351ecc192,
          extraData: { organizationId: this.data.authScopeOrganizationId }
        });
        const selected = new Set(batchResult.completedIds);
        this._authAccountsRaw = (this._authAccountsRaw || []).map((item) =>
          selected.has(item.accountId) ? Object.assign({}, item, { hasRecoveryCode: false }) : item);
        this.setData({ selectedAuthAccountIds: [] });
        this.applyAuthPersonnelFilter(this.data.authSearch);
        showShortToast(batchResult.failures.length ? localeCopy.copy_fe17a0abf0 : localeCopy.copy_4b5b472953,
          batchResult.failures.length ? 'none' : 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_8351ecc192));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    },

    copyAuthIssuedCodes() {
      const content = (this.data.authIssuedCodes || [])
        .map((item) => item.personName + '：' + item.code).join('\n');
      if (content) wx.setClipboardData({ data: content });
    },

    closeAuthCodeDialog() {
      this.setData({ showAuthCodeDialog: false, authIssuedCodes: [] });
    },

    onAuthPolicySwitch(e) {
      const field = String(e.currentTarget.dataset.field || '');
      if (!field || !this.data.authPolicy) return;
      const authPolicy = Object.assign({}, this.data.authPolicy, { [field]: Boolean(e.detail.value) });
      this.setData({ authPolicy });
    },

    onAuthPolicyValue(e) {
      const field = String(e.currentTarget.dataset.field || '');
      if (!field || !this.data.authPolicy) return;
      const value = String(e.detail.value || '');
      this.setData({ authPolicy: Object.assign({}, this.data.authPolicy, { [field]: value }) });
    },

    clearAuthPolicyDate(e) {
      const prefix = String(e.currentTarget.dataset.prefix || '');
      if (!prefix || !this.data.authPolicy) return;
      const authPolicy = Object.assign({}, this.data.authPolicy);
      authPolicy[prefix + 'Date'] = '';
      authPolicy[prefix + 'Time'] = '';
      this.setData({ authPolicy });
    },

    async saveAuthPolicy() {
      const policy = this.data.authPolicy;
      if (!policy || this.data.authActionLoadingKey) return;
      this.setData({ authActionLoadingKey: 'policy-save' });
      try {
        const result = await callFunction({ name: 'admin/auth/policy', data: Object.assign({}, policy, {
          claimStartsAt: combinePolicyDateTime(policy.claimStartsDate, policy.claimStartsTime),
          claimEndsAt: combinePolicyDateTime(policy.claimEndsDate, policy.claimEndsTime)
        }) });
        if (result.status !== 'success') throw new Error(result.message || localeCopy.copy_215e3c57da);
        this.setData({ authPolicy: mapPolicy(result.policy || policy) });
        showShortToast(localeCopy.copy_0aacec2714, 'success');
      } catch (error) {
        showShortToast(getErrorText(error, localeCopy.copy_215e3c57da));
      } finally {
        this.setData({ authActionLoadingKey: '' });
      }
    }
  }
});
