const localeCopy = require('../../../locales/zh-CN/generated/modules/venue/routes/venueApprovalAdmin');
const retiredCopy = require('../../../locales/zh-CN/generated/core/routes/admin');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../../utils/helpers');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const pool = require('../../../config/db');
const { toMysqlUtc } = require('../../../utils/dateTime');
const { resolveRequestAdmin: ensureAdmin } = require('../../../core/services/adminRequestContext');
const { resolveCurrentActor } = require('../../../core/services/currentActor');
const unifiedIdentityModel = require('../../../core/models/unifiedIdentity');
const flowModel = require('../models/venueApprovalFlow');
const stepModel = require('../models/venueApprovalFlowStep');
const ruleModel = require('../models/venueApprovalFlowStepRule');
const venueBookingPolicyModel = require('../models/venueBookingPolicy');
const venueModel = require('../models/venue');
const { normalizeBookingWindow } = require('../services/venueBookingWindow');
const venueBookingModel = require('../models/venueBooking');
const venueBookingRuleModel = require('../models/venueBookingRule');
const { createVenueApprovalNotifications, createVenueBookingStatusNotification } = require('../utils/venueNotificationHelper');
const notificationModel = require('../../audit/models/notification');
const { normalizeRule, normalizeFlowSteps } = require('../utils/approvalFlowValidation');
const {
  authorizeCurrentVenueApproval
} = require('../services/venueApprovalAuthorization');
const venueApprovalMultiFlow = require('../services/venueApprovalMultiFlow');
const { toAssignmentSnapshot } = require('../services/venueAssignmentContext');
const { effectiveBookingStart } = require('../services/venueEffectiveBookingTime');
const dictionaryUsage = require('../../../core/services/dictionaryUsage');

function readDesignationAssignmentIds(body, listKey, legacyKey) {
  const source = body || {};
  const hasList = Object.prototype.hasOwnProperty.call(source, listKey);
  if (hasList && !Array.isArray(source[listKey])) return { valid: false, ids: [] };
  const raw = hasList ? source[listKey] : [source[legacyKey]];
  return {
    valid: true,
    hasList,
    ids: [...new Set(raw.map(function(value) { return safeString(value); }).filter(Boolean))]
  };
}

function collectRuleDictionaryReferences(rule) {
  const item = rule || {};
  return {
    departmentIds: [item.specificDepartmentId],
    identityCategoryIds: [item.specificIdentityId],
    workGroupIds: [item.specificWorkGroupId]
  };
}

// ═══════════════════════════════════════════════════
// Approval Flow CRUD
// ═══════════════════════════════════════════════════

// 单流程读取已被多流程目录替代。
router.post('/getVenueApprovalFlow', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// listVenueApprovalFlows — 返回场地全部审批流（含步骤与规则）
router.post('/listVenueApprovalFlows', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const flows = await flowModel.listByVenueId(venueId);
    const result = [];
    for (const flow of flows) {
      const steps = await stepModel.getByFlowId(flow.id, flow.org_id);
      result.push(Object.assign({}, flow, { steps }));
    }
    res.json({ status: 'success', flows: result });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveVenueApprovalFlowMeta — 仅按显式 flowId 更新审批流元信息（名称与三个开关）
router.post('/saveVenueApprovalFlowMeta', async (req, res) => {
  const conn = await pool.getConnection();
  let transactionStarted = false;
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    const flowId = safeString(req.body.flowId);
    const name = safeString(req.body.name) || localeCopy.copy_890d7f4874;
    const allowUserSelect = req.body.allowUserSelect === true || req.body.allowUserSelect === 'true' || req.body.allowUserSelect === 1;
    const allowDesignateFirst = req.body.allowDesignateFirst === true || req.body.allowDesignateFirst === 'true' || req.body.allowDesignateFirst === 1;
    const allowDesignateNext = req.body.allowDesignateNext === true || req.body.allowDesignateNext === 'true' || req.body.allowDesignateNext === 1;
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });

    await conn.beginTransaction();
    transactionStarted = true;
    const venue = await venueModel.getByIdForUpdate(venueId, conn);
    if (!venue) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    }
    if (!flowId) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    }
    const flow = await flowModel.getById(flowId, conn, true);
    if (!flow) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'not_found', message: localeCopy.copy_db3e12e237 });
    }
    if (safeString(flow.venue_id) !== venueId) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_params', message: localeCopy.copy_00853d1d28 });
    }
    await flowModel.update(flow.id, { name, allowUserSelect, allowDesignateFirst, allowDesignateNext }, conn);
    await conn.commit();
    transactionStarted = false;
    res.json({ status: 'success', flowId: flow.id, message: localeCopy.copy_d185bef128 });
  } catch (e) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) {}
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

// saveVenueApprovalFlow — 已退役；流程配置只允许通过原子保存接口修改。
router.post('/saveVenueApprovalFlow', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// deleteVenueApprovalFlow
router.post('/deleteVenueApprovalFlow', async (req, res) => {
  const conn = await pool.getConnection();
  let transactionStarted = false;
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    const flowId = safeString(req.body.flowId);
    if (!venueId || !flowId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const resolvedVenueId = venueId;
    await conn.beginTransaction();
    transactionStarted = true;
    const venue = await venueModel.getByIdForUpdate(resolvedVenueId, conn);
    if (!venue) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'not_found', message: localeCopy.copy_db3e12e237 });
    }
    const flow = await flowModel.getById(flowId, conn, true);
    if (!flow) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'not_found', message: localeCopy.copy_db3e12e237 });
    }
    if (safeString(flow.venue_id) !== resolvedVenueId) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_params', message: localeCopy.copy_00853d1d28 });
    }
    await flowModel.remove(flow.id, conn);
    await conn.commit();
    transactionStarted = false;
    res.json({ status: 'success', message: localeCopy.copy_94e247d756 });
  } catch (e) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) {}
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

// ═══════════════════════════════════════════════════
// Approval Flow Steps CRUD
// ═══════════════════════════════════════════════════

// saveVenueApprovalStep — 已退役；流程配置只允许通过原子保存接口修改。
router.post('/saveVenueApprovalStep', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// saveVenueApprovalWholeFlow — save the entire flow with steps and rules atomically
router.post('/saveVenueApprovalWholeFlow', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const venueId = safeString(req.body.venueId);
    const flowName = safeString(req.body.flowName) || localeCopy.copy_890d7f4874;
    const flowIdParam = safeString(req.body.flowId);
    const allowUserSelect = req.body.allowUserSelect === true || req.body.allowUserSelect === 'true' || req.body.allowUserSelect === 1;
    const allowDesignateFirst = req.body.allowDesignateFirst === true || req.body.allowDesignateFirst === 'true' || req.body.allowDesignateFirst === 1;
    const allowDesignateNext = req.body.allowDesignateNext === true || req.body.allowDesignateNext === 'true' || req.body.allowDesignateNext === 1;
    const stepsData = normalizeFlowSteps(req.body.steps);

    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });

    await conn.beginTransaction();
    const orgId = await getCurrentOrgId();
    const venue = await venueModel.getByIdForUpdate(venueId, conn);
    if (!venue) {
      await conn.rollback();
      return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    }
    await dictionaryUsage.lockOrganizationDictionaryWrites(orgId, conn);
    for (const step of stepsData) {
      for (const rule of step.rules) {
        await dictionaryUsage.assertDictionaryReferences(Object.assign({
          organizationId: orgId,
          connection: conn
        }, collectRuleDictionaryReferences(rule)));
      }
    }

    // Clean up conflicting 'direct' booking rules when saving a flow
    // (user is explicitly choosing flow-based approval over direct)
    const bookingRules = await venueBookingRuleModel.getByVenueId(venueId, conn, true);
    for (const rule of bookingRules) {
      if (rule.rule_type === 'direct') {
        await venueBookingRuleModel.remove(rule.id, conn);
      }
    }

    // 无 flowId 创建新流程；有 flowId 时只允许更新该场地下的精确记录。
    let flow = null;
    if (flowIdParam) {
      flow = await flowModel.getById(flowIdParam, conn, true);
      if (!flow) {
        await conn.rollback();
        return res.json({ status: 'not_found', message: localeCopy.copy_db3e12e237 });
      }
      if (safeString(flow.venue_id) !== venueId) {
        await conn.rollback();
        return res.json({ status: 'invalid_params', message: localeCopy.copy_00853d1d28 });
      }
    }
    if (flow) {
      await flowModel.update(flow.id, {
        name: flowName,
        allowUserSelect,
        allowDesignateFirst,
        allowDesignateNext
      }, conn);
    } else {
      flow = { id: generateId() };
      await flowModel.create(flow.id, {
        venueId,
        name: flowName,
        allowUserSelect,
        allowDesignateFirst,
        allowDesignateNext
      }, conn);
    }

    // Remove old steps (CASCADE removes rules)
    await stepModel.removeByFlowId(flow.id, conn);

    // Create new steps and rules
    for (let i = 0; i < stepsData.length; i++) {
      const sd = stepsData[i];
      const stepId = generateId();
      const rules = sd.rules;
      const approvalMode = sd.approvalMode;
      await stepModel.create(stepId, {
        flowId: flow.id,
        sortOrder: i + 1,
        name: sd.name || ('第' + (i + 1) + localeCopy.copy_493a127a99),
        approvalMode
      }, conn);

      for (let j = 0; j < rules.length; j++) {
        const rd = rules[j];
        await ruleModel.create(generateId(), {
          stepId,
          sortOrder: j + 1,
          departmentScope: rd.departmentScope || 'all',
          specificDepartmentId: rd.specificDepartmentId || null,
          workGroupScope: rd.workGroupScope || 'all',
          specificWorkGroupId: rd.specificWorkGroupId || null,
          identityScope: rd.identityScope || 'all',
          specificIdentityId: rd.specificIdentityId || null
        }, conn);
      }
    }

    if (req.body.bookingWindow !== undefined) {
      const currentPolicy = await venueBookingPolicyModel.getByVenueId(venueId);
      const bookingWindow = normalizeBookingWindow(Object.assign({}, req.body.bookingWindow, {
        id: currentPolicy ? currentPolicy.id : generateId()
      }));
      await venueBookingPolicyModel.upsert(venueId, bookingWindow, conn);
    }

    await conn.commit();
    res.json({ status: 'success', flowId: flow.id, message: localeCopy.copy_d185bef128 });
  } catch (e) {
    await conn.rollback();
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

// deleteVenueApprovalStep — 已退役；流程配置只允许通过原子保存接口修改。
router.post('/deleteVenueApprovalStep', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// ═══════════════════════════════════════════════════
// Approval Flow Step Rules CRUD
// ═══════════════════════════════════════════════════

// saveVenueApprovalStepRule — 已退役；流程配置只允许通过原子保存接口修改。
router.post('/saveVenueApprovalStepRule', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// deleteVenueApprovalStepRule — 已退役；流程配置只允许通过原子保存接口修改。
router.post('/deleteVenueApprovalStepRule', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

// ═══════════════════════════════════════════════════
// Flow-based Approval / Rejection
// ═══════════════════════════════════════════════════

/**
 * Build approval progress info for display
 */
function buildApprovalProgress(booking) {
  if (!booking.approval_flow_id || booking.approval_total_steps <= 0) {
    return null;
  }
  return {
    flowId: booking.approval_flow_id,
    currentStep: booking.approval_current_step,
    totalSteps: booking.approval_total_steps,
    isApproved: booking.approval_current_step >= booking.approval_total_steps,
    isRejected: booking.approval_current_step < 0,
    rejectStep: booking.approval_reject_step
  };
}

// approveVenueBookingStep — approve at the current step
router.post('/approveVenueBookingStep', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_62d2cac4df });
    const comment = safeString(req.body.comment);

    const actorResult = await resolveCurrentActor(req);
    if (!actorResult.ok) {
      return res.json({ status: actorResult.status, message: actorResult.message });
    }
    const actor = actorResult.actor;
    const orgId = await getCurrentOrgId();
    const nextDesignationRequest = readDesignationAssignmentIds(
      req.body,
      'nextApproverAssignmentIds',
      'nextApproverAssignmentId'
    );
    if (!nextDesignationRequest.valid) {
      return res.json({ status: 'invalid_params', message: venueApprovalMultiFlow.REASONS.DESIGNATE_INVALID });
    }
    const nextApproverAssignmentIds = nextDesignationRequest.ids;

    await conn.beginTransaction();
    const approvalSubjects = [{
      personId: safeString(actor.personId),
      organizationId: orgId,
      assignmentId: safeString(actor.assignmentId),
      requireMembership: safeString(actor.type) === 'user'
    }];
    for (const assignmentId of nextApproverAssignmentIds) {
      approvalSubjects.push({
        organizationId: orgId,
        assignmentId
      });
    }
    await unifiedIdentityModel.lockActiveBusinessSubjects(conn, approvalSubjects);
    const booking = await venueBookingModel.getByIdForUpdate(id, conn);
    if (!booking || booking.approval_org_id !== orgId) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_3508043e2a });
    }
    if (booking.status !== 'pending') {
      await conn.rollback();
      return res.json({ status: 'success', message: localeCopy.copy_3b95420d79, bookingStatus: booking.status, idempotent: true });
    }
    if ((!booking.approval_flow_id && !booking.approval_flow_state_json) || Number(booking.approval_total_steps) <= 0) {
      await conn.rollback();
      return res.json({ status: 'invalid_state', message: localeCopy.copy_a56890077c });
    }

    if (!nextDesignationRequest.hasList && req.body.nextApproverHrId && !nextApproverAssignmentIds.length) {
      await conn.rollback();
      return res.json({ status: 'invalid_params', message: localeCopy.copy_legacyApproverSelection });
    }
    const nextDesignations = nextApproverAssignmentIds.map(function(assignmentId) {
      return { assignmentId };
    });
    let prepared;
    try {
      prepared = await venueApprovalMultiFlow.prepareApproval(
        booking,
        actor,
        comment,
        nextDesignations,
        orgId,
        safeString(req.body.flowId),
        conn
      );
    } catch (e) {
      await conn.rollback();
      return res.json({ status: 'invalid_params', message: safeString(e.message) || localeCopy.copy_65f251c459 });
    }
    if (!prepared.ok) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: prepared.reason });
    }
    const completed = Boolean(prepared.completed);
    const snapshots = prepared.snapshots;
    const state = prepared.state;
    const totalSteps = prepared.totalSteps;
    const approvalActor = prepared.actor || actor;
    const approverActorId = approvalActor.id;

    // Check time conflict + adjust time_start based on approval time (only for final approval)
    if (completed) {
      const approvedAt = new Date();
      const bookingTimeEnd = new Date(booking.time_end);

      // If approved after booking end, cancel instead
      if (approvedAt > bookingTimeEnd) {
        await venueBookingModel.updateStatus(
          id,
          'cancelled',
          approverActorId,
          '审批时借用已结束，自动取消',
          conn,
          actor
        );
        await createVenueBookingStatusNotification(
          booking, 'booking_cancelled', '场地借用已自动取消',
          '您申请的「' + (booking.title || localeCopy.copy_592351d93c) + localeCopy.copy_7b831c34ee, conn
        );
        await conn.commit();
        return res.json({ status: 'expired', message: localeCopy.copy_aa20a1e7b8 });
      }

      // 未来借用保持原开始时间；只有审批时原开始时间已过去，才从审批时刻起生效。
      const originalTimeStart = new Date(booking.time_start);
      const effectiveTimeStart = effectiveBookingStart(originalTimeStart, approvedAt);
      if (effectiveTimeStart.getTime() !== originalTimeStart.getTime()) {
        await venueBookingModel.updateTimeStart(id, toMysqlUtc(effectiveTimeStart), conn);
      }

      const timeStart = toMysqlUtc(effectiveTimeStart);
      const timeEnd = toMysqlUtc(new Date(booking.time_end));
      const conflict = await venueBookingModel.findConflict(booking.venue_id, timeStart, timeEnd, id, conn, true);
      if (conflict) {
        await conn.rollback();
        return res.json({ status: 'conflict', message: localeCopy.copy_dcd1184a46 });
      }
    }

    const newStatus = completed ? 'approved' : 'pending';
    const legacy = venueApprovalMultiFlow.legacyColumnsFromState(state, totalSteps, newStatus);
    await venueBookingModel.updateStatus(
      id,
      newStatus,
      actor.id,
      completed ? (comment || booking.approval_comment) : booking.approval_comment,
      conn,
      approvalActor
    );
    await venueBookingModel.updateApprovalFlowState(id, {
      approvalFlowState: state,
      approvalFlowId: legacy.approvalFlowId,
      currentStep: legacy.currentStep,
      totalSteps: legacy.totalSteps,
      snapshotsJson: JSON.stringify(snapshots)
    }, conn);

    if (completed) {
      const venueName = booking.venue_name || '';
      await createVenueBookingStatusNotification(
        booking, 'booking_approved', '场地借用已通过',
        '您申请的「' + (booking.title || localeCopy.copy_592351d93c) + '」' + (venueName ? '（' + venueName + '）' : '') + localeCopy.copy_71ff2a4a29, conn
      );
    }

    await conn.commit();

    // 事务已经提交；通知清理失败只能记录并重试，不能把已成功审批响应成失败。
    await notificationModel.deleteByTarget('booking', id).catch(function(error) {
      console.error('[venueApprovalAdmin] pending notification cleanup failed:', error.message);
    });

    // 下一步骤待办由业务状态实时计算。
    if (!completed) {
      await createVenueApprovalNotifications(id).catch(function(error) {
        console.error('[venueApprovalAdmin] notification cleanup failed:', error.message);
      });
    }

    res.json({
      status: 'success',
      message: completed ? localeCopy.copy_bc02bd8ffe : localeCopy.copy_8a21926f75,
      approvalProgress: {
        currentStep: legacy.currentStep,
        totalSteps: totalSteps,
        isApproved: completed,
        isRejected: false
      },
      completed: completed,
      processedStepCount: Number(prepared.processedStepCount) || 1,
      autoApprovedStepCount: Number(prepared.autoApprovedStepCount) || 0,
      activeFlowIds: prepared.summary.activeFlowIds,
      flowSummary: prepared.summary.flowSummary,
      candidateMissing: Boolean(prepared.candidateMissing)
    });
  } catch (e) {
    await conn.rollback();
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

// rejectVenueBookingStep — reject at the current step
router.post('/rejectVenueBookingStep', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_62d2cac4df });
    const comment = safeString(req.body.comment);

    const actorResult = await resolveCurrentActor(req);
    if (!actorResult.ok) {
      return res.json({ status: actorResult.status, message: actorResult.message });
    }
    const actor = actorResult.actor;
    const orgId = await getCurrentOrgId();

    await conn.beginTransaction();
    await unifiedIdentityModel.lockActiveBusinessSubjects(conn, [{
      personId: safeString(actor.personId),
      organizationId: orgId,
      assignmentId: safeString(actor.assignmentId),
      requireMembership: safeString(actor.type) === 'user'
    }]);
    const booking = await venueBookingModel.getByIdForUpdate(id, conn);
    if (!booking || booking.approval_org_id !== orgId) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_3508043e2a });
    }
    if (booking.status !== 'pending') {
      await conn.rollback();
      return res.json({ status: 'success', message: localeCopy.copy_3b95420d79, bookingStatus: booking.status, idempotent: true });
    }

    const eligibility = await venueApprovalMultiFlow.evaluateActorEligibility(booking, actor, orgId);
    if (!eligibility.ok) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: eligibility.reason });
    }
    const approvalActor = eligibility.actor || actor;
    const approverActorId = approvalActor.id;
    const totalSteps = Number(booking.approval_total_steps) || 0;
    const matchedFlow = venueApprovalMultiFlow.selectMatchedFlow(eligibility, safeString(req.body.flowId));
    if (!matchedFlow) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: localeCopy.copy_511125fe12 });
    }
    const rejectStep = Number(matchedFlow.st.stepIndex);
    const rejectedAt = new Date().toISOString();
    eligibility.state.selectedFlowId = matchedFlow.flowId;
    eligibility.state.rejection = {
      flowId: matchedFlow.flowId,
      flowName: safeString(matchedFlow.flow && matchedFlow.flow.name),
      stepIndex: rejectStep,
      stepName: safeString(matchedFlow.step && matchedFlow.step.name),
      rejectedAt,
      comment: comment || localeCopy.copy_b4432643e3,
      approverHrId: safeString(approvalActor.id),
      approverPersonId: safeString(approvalActor.personId),
      approverAssignmentId: safeString(approvalActor.assignmentId),
      approverAdminGrantId: safeString(approvalActor.adminGrantId),
      approverContextId: safeString(approvalActor.contextId),
      approverIdentityType: safeString(approvalActor.type),
      approverName: safeString(approvalActor.name),
      approverAssignmentSnapshot: approvalActor.assignment
        ? toAssignmentSnapshot(approvalActor.assignment)
        : null
    };
    for (const flowId of Object.keys(eligibility.state.flows)) {
      const flowState = eligibility.state.flows[flowId];
      flowState.active = false;
      if (flowId === matchedFlow.flowId) {
        flowState.rejected = true;
      } else {
        flowState.superseded = true;
      }
    }

    // Reject: set step to -1, update status atomically within transaction
    await venueBookingModel.updateStatus(
      id,
      'rejected',
      approverActorId,
      comment || localeCopy.copy_b4432643e3,
      conn,
      approvalActor
    );

    // Update approval tracking (same transaction)
    const legacy = venueApprovalMultiFlow.legacyColumnsFromState(eligibility.state, totalSteps, 'rejected');
    await venueBookingModel.updateApprovalFlowState(id, {
      approvalFlowState: eligibility.state,
      approvalFlowId: legacy.approvalFlowId,
      currentStep: -1,
      totalSteps: totalSteps,
      rejectStep: rejectStep,
      snapshotsJson: JSON.stringify(venueApprovalMultiFlow.parseSnapshots(booking.approval_snapshots_json))
    }, conn);

    const venueName = booking.venue_name || '';
    await createVenueBookingStatusNotification(
      booking, 'booking_rejected', '场地借用被驳回',
      '您申请的「' + (booking.title || localeCopy.copy_592351d93c) + '」' + (venueName ? '（' + venueName + '）' : '') + localeCopy.copy_f553985be3 +
        (comment ? '，原因：' + comment : ''), conn
    );

    await conn.commit();

    // 事务已经提交；通知清理失败不能反向改变业务结果。
    await notificationModel.deleteByTarget('booking', id).catch(function(error) {
      console.error('[venueApprovalAdmin] pending notification cleanup failed:', error.message);
    });

    res.json({ status: 'success', message: localeCopy.copy_c7b826b0c0 });
  } catch (e) {
    await conn.rollback();
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

module.exports = router;
module.exports.authorizeCurrentVenueApproval = authorizeCurrentVenueApproval;
module.exports.buildApprovalProgress = buildApprovalProgress;
