const localeCopy = require('../../../locales/zh-CN/generated/modules/venue/routes/venueAdmin');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../../utils/helpers');
const {
  isBookingPurposeLengthValid
} = require('../services/venueTextValidation');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const pool = require('../../../config/db');
const systemConfigModel = require('../../../core/models/systemConfig');
const { parseSystemDateTime, systemDateTimeToMysqlUtc, toMysqlUtc } = require('../../../utils/dateTime');
const { resolveRequestAdmin: ensureAdmin } = require('../../../core/services/adminRequestContext');
const { resolveCurrentActor } = require('../../../core/services/currentActor');
const unifiedIdentityModel = require('../../../core/models/unifiedIdentity');
const { resolveVenueViewerScope, canViewBookingDetails, resolveVenueOrgNames } = require('../services/venueViewerScope');
const { getAuthenticatedContext } = require('../../../core/services/authenticatedContext');
const venueModel = require('../models/venue');
const venueOpenRuleModel = require('../models/venueOpenRule');
const venueActivityRuleModel = require('../models/venueActivityRule');
const venueBookingRuleModel = require('../models/venueBookingRule');
const venueBookingPolicyModel = require('../models/venueBookingPolicy');
const venueBookingModel = require('../models/venueBooking');
const venueBookingPurposeModel = require('../models/venueBookingPurpose');
const venueApprovalFlowModel = require('../models/venueApprovalFlow');
const { createVenueBookingStatusNotification } = require('../utils/venueNotificationHelper');
const notificationModel = require('../../audit/models/notification');
const requestDeduplication = require('../../../utils/requestDeduplication');
const dictionaryUsage = require('../../../core/services/dictionaryUsage');
const {
  authorizeCurrentVenueApproval
} = require('../services/venueApprovalAuthorization');
const venueApprovalMultiFlow = require('../services/venueApprovalMultiFlow');
const { normalizeBookingWindow, fromRow } = require('../services/venueBookingWindow');
const { getActivitySlots: buildActivitySlots, ruleValidationError } = require('../services/venueActivitySchedule');
const { evaluateBookingRules } = require('../services/venueBookingRuleAuthorization');
const { effectiveBookingStart } = require('../services/venueEffectiveBookingTime');
const {
  toRuleProfile,
  resolveCurrentActorAssignment,
  resolveBookingApplicantAssignment,
  resolveBookingApplicantAssignments,
  listActiveAssignmentsByLegacyHrId
} = require('../services/venueAssignmentContext');

function assignmentDisplay(assignment) {
  const hasHistoricalSnapshot = Boolean(assignment && assignment.historicalSnapshotComplete);
  return {
    name: safeString(assignment && assignment.personName),
    department: hasHistoricalSnapshot ? safeString(assignment.departmentName) : '',
    identity: hasHistoricalSnapshot ? safeString(assignment.identityCategoryName) : '',
    workGroup: hasHistoricalSnapshot ? safeString(assignment.workGroupName) : '',
    assignmentId: safeString(assignment && assignment.assignmentId),
    assignmentLabel: hasHistoricalSnapshot ? safeString(assignment.assignmentLabel) : ''
  };
}

async function canReviewVenueBooking(req, booking) {
  const actorResult = await resolveCurrentActor(req);
  if (!actorResult.ok) {
    return { ok: false, admin: null, hrId: null, reason: actorResult.message };
  }
  const actor = actorResult.actor;
  const admin = actor.type === 'admin' ? actor.profile : null;
  const hrId = actor.type === 'user' ? actor.id : null;
  if (actor.type === 'user') {
    const assignment = await resolveCurrentActorAssignment(actor, booking.approval_org_id);
    if (!assignment) return { ok: false, admin, hrId, actor, reason: localeCopy.copy_6b48c1ab98 };
    actor.assignment = assignment;
    actor.profile = toRuleProfile(assignment);
  }

  // 流程审批统一使用共享授权器，确保查询、待办和写操作结论一致。
  if (booking.approval_flow_id && booking.approval_total_steps > 0) {
    const authorization = await authorizeCurrentVenueApproval(booking, actor);
    return { ...authorization, admin, hrId, actor: authorization.actor || actor };
  }

  // Legacy rule-based approval
  const applicantAssignment = await resolveBookingApplicantAssignment(booking);
  if (!applicantAssignment) {
    return { ok: false, admin, hrId, actor, reason: localeCopy.historicalAssignmentMissing };
  }
  const rules = await venueBookingRuleModel.getByVenueId(booking.venue_id);
  const hasDirect = rules.some(function(rule) { return rule.rule_type === 'direct'; });
  if (hasDirect) return { ok: false, admin, hrId, actor, reason: localeCopy.copy_b1cd1c282b };
  return { ok: evaluateBookingRules(rules, actor), admin, hrId, actor };
}

function isFlowManagedBooking(booking) {
  return Boolean(
    safeString(booking && booking.approval_flow_id)
    || safeString(booking && booking.approval_flow_state_json)
    || Number(booking && booking.approval_total_steps) > 0
  );
}

function rejectLegacyFlowEndpoint(req, res) {
  return res.status(410).json({
    status: 'client_upgrade_required',
    message: localeCopy.copy_b71a0c7ed7,
    requestId: req.requestId
  });
}

function fmtLocalDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseAdminBookingDatetime(value) {
  const normalized = safeString(value).replace('T', ' ');
  const [datePart, timePart] = normalized.split(' ');
  const [year, month, day] = (datePart || '').split('-').map(Number);
  const [hour, minute] = (timePart || '').split(':').map(Number);
  const date = new Date(year, month - 1, day, hour || 0, minute || 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function venueRuleMatchesDate(rule, dateText) {
  let values = rule.cycle_values || [];
  if (typeof values === 'string') {
    try { values = JSON.parse(values); } catch (_) { values = []; }
  }
  if (rule.cycle_type === 'daily') return true;
  if (rule.cycle_type === 'range') return !!values && dateText >= values.startDate && dateText <= values.endDate;
  const date = new Date(dateText + 'T00:00:00');
  if (rule.cycle_type === 'weekly') return values.indexOf(date.getDay() === 0 ? 7 : date.getDay()) !== -1;
  if (rule.cycle_type === 'monthly') return values.indexOf(date.getDate()) !== -1;
  if (rule.cycle_type === 'yearly') {
    return values.some((item) => Number(item.m) === date.getMonth() + 1 && date.getDate() >= Number(item.dStart !== undefined ? item.dStart : item.d) && date.getDate() <= Number(item.dEnd !== undefined ? item.dEnd : item.d));
  }
  return false;
}

function minutesOf(value) {
  const parts = safeString(value).split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

// ═══════════════════════════════════════════════════
// Venue CRUD
// ═══════════════════════════════════════════════════

// listVenues
router.post('/listVenues', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venues = await venueModel.getAll();
    res.json({ status: 'success', venues });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveVenue
router.post('/saveVenue', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id) || generateId();
    const name = safeString(req.body.name);
    if (!name) return res.json({ status: 'invalid_params', message: localeCopy.copy_4514e50856 });
    const data = {
      name,
      location: safeString(req.body.location),
      description: safeString(req.body.description),
      imageUrl: safeString(req.body.imageUrl)
    };
    const existing = await venueModel.getById(id);
    if (existing) {
      await venueModel.update(id, data);
    } else {
      await venueModel.create(id, data);
    }
    res.json({ status: 'success', id, message: existing ? localeCopy.copy_0c95f1e1c6 : localeCopy.copy_ecda79c975 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteVenue
router.post('/deleteVenue', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    await venueModel.remove(id);
    res.json({ status: 'success', message: localeCopy.copy_bbcf12ed5f });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ═══════════════════════════════════════════════════
// Open Time Rules
// ═══════════════════════════════════════════════════

// listVenueOpenRules
router.post('/listVenueOpenRules', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const rules = await venueOpenRuleModel.getByVenueId(venueId);
    res.json({ status: 'success', rules: rules.map(r => ({ ...r, time_start: (r.time_start||'').substring(0,5), time_end: (r.time_end||'').substring(0,5) })) });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveVenueOpenRule
router.post('/saveVenueOpenRule', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id) || generateId();
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const data = {
      venueId,
      name: safeString(req.body.name),
      cycleType: safeString(req.body.cycleType) || 'weekly',
      cycleValues: req.body.cycleValues || [],
      timeStart: safeString(req.body.timeStart) || '09:00',
      timeEnd: safeString(req.body.timeEnd) || '18:00'
    };
    const existing = await venueOpenRuleModel.getById(id);
    if (existing) {
      await venueOpenRuleModel.update(id, data);
    } else {
      await venueOpenRuleModel.create(id, data);
    }
    res.json({ status: 'success', id, message: existing ? localeCopy.copy_11748a2634 : localeCopy.copy_cf3264f4d8 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteVenueOpenRule
router.post('/deleteVenueOpenRule', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_918e0dfb9f });
    await venueOpenRuleModel.remove(id);
    res.json({ status: 'success', message: localeCopy.copy_67f5f44b1e });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ═══════════════════════════════════════════════════
// Activity Rules
// ═══════════════════════════════════════════════════

// listVenueActivityRules
router.post('/listVenueActivityRules', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const rules = await venueActivityRuleModel.getByVenueId(venueId);
    res.json({ status: 'success', rules: rules.map(r => ({ ...r, time_start: (r.time_start||'').substring(0,5), time_end: (r.time_end||'').substring(0,5) })) });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveVenueActivityRule
router.post('/saveVenueActivityRule', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id) || generateId();
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const data = {
      venueId,
      activityName: safeString(req.body.activityName),
      cycleType: safeString(req.body.cycleType) || 'weekly',
      cycleValues: req.body.cycleValues || [],
      timeStart: safeString(req.body.timeStart) || '09:00',
      timeEnd: safeString(req.body.timeEnd) || '18:00'
    };
    const validationError = ruleValidationError(data);
    if (validationError) return res.json({ status: 'invalid_params', message: validationError });
    const existing = await venueActivityRuleModel.getById(id);
    if (existing) {
      await venueActivityRuleModel.update(id, data);
    } else {
      await venueActivityRuleModel.create(id, data);
    }
    res.json({ status: 'success', id, message: existing ? localeCopy.copy_11748a2634 : localeCopy.copy_cf3264f4d8 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteVenueActivityRule
router.post('/deleteVenueActivityRule', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_7d5771fc37 });
    await venueActivityRuleModel.remove(id);
    res.json({ status: 'success', message: localeCopy.copy_67f5f44b1e });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ═══════════════════════════════════════════════════
// Booking Approval Rules
// ═══════════════════════════════════════════════════

// listVenueBookingRules
router.post('/listVenueBookingRules', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const rules = await venueBookingRuleModel.getByVenueId(venueId);
    const bookingWindow = fromRow(await venueBookingPolicyModel.getByVenueId(venueId));
    res.json({ status: 'success', rules, bookingWindow });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveVenueBookingWindow — 场地级借用时间窗口独立保存，不依附审批规则编辑器
router.post('/saveVenueBookingWindow', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const currentPolicy = await venueBookingPolicyModel.getByVenueId(venueId);
    const bookingWindow = normalizeBookingWindow(Object.assign({}, req.body.bookingWindow, {
      id: currentPolicy ? currentPolicy.id : generateId()
    }));
    await venueBookingPolicyModel.upsert(venueId, bookingWindow);
    res.json({ status: 'success', message: localeCopy.copy_26f68cb229 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveVenueBookingRule
router.post('/saveVenueBookingRule', async (req, res) => {
  let conn = null;
  let transactionStarted = false;
  try {
    conn = await pool.getConnection();
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id) || generateId();
    const venueId = safeString(req.body.venueId);
    if (!venueId) return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    const ruleType = safeString(req.body.ruleType) || 'admin';
    if (!['admin', 'direct', 'identity', 'person'].includes(ruleType)) {
      return res.json({ status: 'invalid_params', message: localeCopy.invalidBookingRuleType });
    }
    const orgId = await getCurrentOrgId();
    const approverIdentityId = ruleType === 'identity' ? safeString(req.body.approverIdentityId) : '';
    const approverHrId = ruleType === 'person' ? safeString(req.body.approverHrId) : '';
    const approverAssignmentId = ruleType === 'person' ? safeString(req.body.approverAssignmentId) : '';
    const scopeDepartmentId = safeString(req.body.scopeDepartmentId);
    const scopeWorkGroupId = safeString(req.body.scopeWorkGroupId);
    if (ruleType === 'identity' && !approverIdentityId) {
      return res.json({ status: 'invalid_params', message: localeCopy.bookingRuleIdentityRequired });
    }
    if (ruleType === 'person') {
      if (!approverHrId || !approverAssignmentId) {
        return res.json({ status: 'invalid_params', message: localeCopy.bookingRuleAssignmentRequired });
      }
    }

    await conn.beginTransaction();
    transactionStarted = true;
    const venue = await venueModel.getByIdForUpdate(venueId, conn);
    if (!venue) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    }

    await dictionaryUsage.assertDictionaryReferences({
      organizationId: orgId,
      departmentIds: scopeDepartmentId ? [scopeDepartmentId] : [],
      identityCategoryIds: approverIdentityId ? [approverIdentityId] : [],
      workGroupIds: scopeWorkGroupId ? [scopeWorkGroupId] : [],
      connection: conn
    });
    if (ruleType === 'person') {
      const activeAssignments = await listActiveAssignmentsByLegacyHrId(approverHrId, orgId, conn);
      if (!activeAssignments.some(function(item) { return safeString(item.assignmentId) === approverAssignmentId; })) {
        await conn.rollback();
        transactionStarted = false;
        return res.json({ status: 'invalid_params', message: localeCopy.bookingRuleAssignmentInvalid });
      }
    }

    // 同一场地的规则切换由场地行串行化，避免并发写入产生“直接通过 + 审批流”混合状态。
    const existing = await venueBookingRuleModel.getById(id, conn, true);
    if (existing && safeString(existing.venue_id) !== venueId) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_params', message: localeCopy.copy_3458928c55 });
    }
    const allRules = await venueBookingRuleModel.getByVenueId(venueId, conn, true);
    const otherRules = allRules.filter(r => r.id !== id);

    if (ruleType === 'direct') {
      // 直接通过与其他规则、全部审批流互斥，必须在同一事务内完成切换。
      await venueBookingRuleModel.removeByVenueId(venueId, conn);
      await venueApprovalFlowModel.removeByVenueId(venueId, conn);
    } else if (otherRules.some(r => r.rule_type === 'direct')) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'invalid_params', message: localeCopy.copy_5a1d00f140 });
    }

    const data = {
      venueId,
      ruleType,
      approverIdentityId,
      approverHrId,
      approverAssignmentId,
      scopeDepartmentId,
      scopeWorkGroupId,
      sortOrder: parseInt(req.body.sortOrder) || 1
    };
    if (existing && ruleType !== 'direct') {
      await venueBookingRuleModel.update(id, data, conn);
    } else {
      await venueBookingRuleModel.create(id, data, conn);
    }
    if (req.body.bookingWindow !== undefined) {
      const currentPolicy = await venueBookingPolicyModel.getByVenueId(venueId);
      const bookingWindow = normalizeBookingWindow(Object.assign({}, req.body.bookingWindow, {
        id: currentPolicy ? currentPolicy.id : generateId()
      }));
      await venueBookingPolicyModel.upsert(venueId, bookingWindow, conn);
    }
    await conn.commit();
    transactionStarted = false;
    res.json({ status: 'success', id, message: existing ? localeCopy.copy_11748a2634 : localeCopy.copy_cf3264f4d8 });
  } catch (e) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) {}
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// deleteVenueBookingRule
router.post('/deleteVenueBookingRule', async (req, res) => {
  let conn = null;
  let transactionStarted = false;
  try {
    conn = await pool.getConnection();
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_0a29a31b8e });
    const existing = await venueBookingRuleModel.getById(id);
    if (!existing) return res.json({ status: 'not_found', message: localeCopy.copy_0a29a31b8e });
    await conn.beginTransaction();
    transactionStarted = true;
    const venue = await venueModel.getByIdForUpdate(existing.venue_id, conn);
    const lockedRule = await venueBookingRuleModel.getById(id, conn, true);
    if (!venue || !lockedRule || safeString(lockedRule.venue_id) !== safeString(existing.venue_id)) {
      await conn.rollback();
      transactionStarted = false;
      return res.json({ status: 'not_found', message: localeCopy.copy_0a29a31b8e });
    }
    await venueBookingRuleModel.remove(id, conn);
    await conn.commit();
    transactionStarted = false;
    res.json({ status: 'success', message: localeCopy.copy_67f5f44b1e });
  } catch (e) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) {}
    }
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    if (conn) conn.release();
  }
});

// ═══════════════════════════════════════════════════
// Booking Management
// ═══════════════════════════════════════════════════

// createAdminVenueBooking — 管理员从排期表创建免审借用
router.post('/createAdminVenueBooking', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const venueId = safeString(req.body.venueId);
    const title = safeString(req.body.title);
    const description = safeString(req.body.description);
    const systemConfig = await systemConfigModel.get();
    const timezoneOffset = systemConfig ? systemConfig.timezone : 8;
    const start = parseAdminBookingDatetime(req.body.timeStart);
    const end = parseAdminBookingDatetime(req.body.timeEnd);
    const absoluteStart = parseSystemDateTime(safeString(req.body.timeStart), timezoneOffset);
    const absoluteEnd = parseSystemDateTime(safeString(req.body.timeEnd), timezoneOffset);
    if (!venueId || !title || !start || !end || !absoluteStart || !absoluteEnd) return res.json({ status: 'invalid_params', message: localeCopy.copy_90c32deaa9 });
    if (fmtLocalDate(start) !== fmtLocalDate(end)) return res.json({ status: 'invalid_params', message: localeCopy.copy_f450f21538 });
    if (absoluteEnd <= absoluteStart) return res.json({ status: 'invalid_params', message: localeCopy.copy_0b091cba77 });
    if (absoluteStart < new Date()) return res.json({ status: 'invalid_params', message: localeCopy.copy_10df33d76e });
    const venue = await venueModel.getById(venueId);
    if (!venue || !venue.is_active) return res.json({ status: 'not_found', message: localeCopy.copy_04ab0b03d0 });

    const dateText = fmtLocalDate(start);
    const rangeStart = start.getHours() * 60 + start.getMinutes();
    const rangeEnd = end.getHours() * 60 + end.getMinutes();
    const [openRules, activityRules] = await Promise.all([
      venueOpenRuleModel.getByVenueId(venueId),
      venueActivityRuleModel.getByVenueId(venueId)
    ]);
    const matchingOpen = openRules.filter((rule) => rule.is_active && venueRuleMatchesDate(rule, dateText));
    const covered = matchingOpen.some((rule) => minutesOf(rule.time_start) <= rangeStart && minutesOf(rule.time_end) >= rangeEnd);
    if (!covered) return res.json({ status: 'conflict', message: localeCopy.copy_ac59b4dfc5 });
    const activitySlots = buildActivitySlots(dateText, activityRules, timezoneOffset);
    const activityConflict = activitySlots.some((slot) => minutesOf(slot.timeStart) < rangeEnd && minutesOf(slot.timeEnd) > rangeStart);
    if (activityConflict) return res.json({ status: 'conflict', message: localeCopy.copy_f64d815664 });

    await conn.beginTransaction();
    const id = generateId();
    const orgId = await getCurrentOrgId();
    if (safeString(req.authContext && req.authContext.personId)) {
      await unifiedIdentityModel.lockActiveBusinessSubjects(conn, [{
        personId: safeString(req.authContext.personId),
        organizationId: orgId,
        assignmentId: safeString(req.authContext.assignmentId),
        requireMembership: Boolean(safeString(req.authContext.assignmentId))
      }]);
    }
    const dedupClaim = await requestDeduplication.claim(conn, {
      orgId,
      actorKey: 'admin:' + admin.id,
      operationType: 'create_admin_venue_booking',
      clientRequestId: req.body.clientRequestId,
      resourceId: id
    });
    if (!dedupClaim.claimed) {
      await conn.commit();
      return res.json(dedupClaim.response || {
        status: 'success', id: dedupClaim.resourceId, bookingStatus: 'approved', message: localeCopy.copy_eb813c46d9, idempotent: true
      });
    }
    const dbStart = systemDateTimeToMysqlUtc(safeString(req.body.timeStart), timezoneOffset);
    const dbEnd = systemDateTimeToMysqlUtc(safeString(req.body.timeEnd), timezoneOffset);
    const conflict = await venueBookingModel.findConflict(venueId, dbStart, dbEnd, null, conn, true);
    if (conflict) {
      await conn.rollback();
      return res.json({ status: 'conflict', message: localeCopy.copy_4695db56e2 });
    }
    await venueBookingModel.create(id, {
      venueId,
      creatorType: 'admin',
      creatorAdminId: admin.id,
      creatorPersonId: req.authContext && req.authContext.personId,
      creatorAdminGrantId: req.authContext && req.authContext.adminGrantId,
      creatorContextSnapshot: req.authContext ? {
        contextId: req.authContext.contextId,
        organizationId: req.authContext.organizationId,
        role: req.authContext.role,
        identityName: req.authContext.identityName,
        adminLevel: req.authContext.adminLevel
      } : null,
      creatorOrgId: orgId,
      approvalOrgId: orgId,
      title,
      description,
      timeStart: dbStart,
      timeEnd: dbEnd,
      status: 'approved'
    }, conn);
    const response = { status: 'success', id, bookingStatus: 'approved', message: localeCopy.copy_eb813c46d9 };
    await requestDeduplication.complete(conn, {
      ...dedupClaim,
      resourceId: id,
      orgId,
      actorKey: 'admin:' + admin.id,
      operationType: 'create_admin_venue_booking'
    }, response);
    await conn.commit();
    res.json(response);
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    if (e && e.code === 'INVALID_CLIENT_REQUEST_ID') {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_6fb89690d9 });
    }
    console.error('[venue:createAdminVenueBooking]', req.requestId || '-', e);
    res.json({ status: 'error', message: localeCopy.copy_b3614bb93e });
  } finally {
    conn.release();
  }
});

// listAllVenueBookings
router.post('/listAllVenueBookings', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const filters = {
      venueId: safeString(req.body.venueId),
      status: safeString(req.body.status),
      userHrId: safeString(req.body.userHrId)
    };
    // Datetime range filters
    const timeFrom = safeString(req.body.timeFrom);
    const timeTo = safeString(req.body.timeTo);
    if (timeFrom) filters.timeFrom = timeFrom;
    if (timeTo) filters.timeTo = timeTo;
    const bookings = await venueBookingModel.getAll(filters);
    const orgId = await getCurrentOrgId();
    const viewerScope = await resolveVenueViewerScope(req);
    const canViewDetails = (booking) => canViewBookingDetails(booking, viewerScope);
    // 跨组织记录不在管理端借用列表出现，只在日程图中显示占用
    const detailBookings = bookings.filter(canViewDetails);
    const applicantAssignments = await resolveBookingApplicantAssignments(detailBookings);
    const orgNameMap = await resolveVenueOrgNames(
      detailBookings.map(b => safeString(b.creator_org_id) || safeString(b.approval_org_id))
    );
    // Build user info map
    const hrIds = [...new Set(detailBookings.map(b => b.user_hr_id).filter(Boolean))];
    const userMap = {};
    const adminIds = [...new Set(detailBookings.filter(b => b.creator_type === 'admin').map(b => b.creator_admin_id).filter(Boolean))];
    const adminMap = {};
    if (adminIds.length) {
      const [adminRows] = await pool.query('SELECT id, name FROM admin_info WHERE id IN (?)', [adminIds]);
      adminRows.forEach(item => { adminMap[item.id] = item.name || localeCopy.copy_c01a9aef59; });
    }
    if (hrIds.length) {
      try {
        // 跨组织借用记录的人事信息按各 hr 自身所属组织解析
        const placeholders = hrIds.map(() => '?').join(',');
        const [hrList] = await pool.query(
          `SELECT * FROM hr_info WHERE id IN (${placeholders})`,
          hrIds
        );
        const deptIdsByOrg = {};
        const identIdsByOrg = {};
        const wgIdsByOrg = {};
        (hrList || []).forEach(h => {
          const org = safeString(h.org_id);
          if (!deptIdsByOrg[org]) deptIdsByOrg[org] = new Set();
          if (!identIdsByOrg[org]) identIdsByOrg[org] = new Set();
          if (!wgIdsByOrg[org]) wgIdsByOrg[org] = new Set();
          if (h.department_id) deptIdsByOrg[org].add(h.department_id);
          if (h.identity_id) identIdsByOrg[org].add(h.identity_id);
          if (h.work_group_id) wgIdsByOrg[org].add(h.work_group_id);
        });
        const deptMap = {};
        const identMap = {};
        const wgMap = {};
        for (const org of Object.keys(deptIdsByOrg)) {
          const deptIds = [...deptIdsByOrg[org]];
          const identIds = [...identIdsByOrg[org]];
          const wgIds = [...wgIdsByOrg[org]];
          const [deptRows, identRows, wgRows] = await Promise.all([
            deptIds.length ? pool.query('SELECT id, name FROM departments WHERE id IN (?) AND org_id = ?', [deptIds, org]) : Promise.resolve([[]]),
            identIds.length ? pool.query('SELECT id, name FROM identities WHERE id IN (?) AND org_id = ?', [identIds, org]) : Promise.resolve([[]]),
            wgIds.length ? pool.query('SELECT id, name FROM work_groups WHERE id IN (?) AND org_id = ?', [wgIds, org]) : Promise.resolve([[]])
          ]);
          (deptRows[0] || []).forEach(r => { deptMap[org + '|' + r.id] = r.name; });
          (identRows[0] || []).forEach(r => { identMap[org + '|' + r.id] = r.name; });
          (wgRows[0] || []).forEach(r => { wgMap[org + '|' + r.id] = r.name; });
        }
        (hrList || []).forEach(h => {
          const org = safeString(h.org_id);
          userMap[h.id] = {
            name: h.name || localeCopy.copy_de00c3e48a,
            department: deptMap[org + '|' + h.department_id] || '',
            identity: identMap[org + '|' + h.identity_id] || '',
            workGroup: wgMap[org + '|' + h.work_group_id] || ''
          };
        });
      } catch (_) {}
    }
    const list = detailBookings.map(b => {
      const applicant = assignmentDisplay(applicantAssignments.get(safeString(b.id)));
      return {
      id: b.id,
      venueId: b.venue_id,
      venueName: b.venue_name,
      venueLocation: b.venue_location,
      visibility: 'details',
      creatorOrgId: b.creator_org_id,
      approvalOrgId: b.approval_org_id,
      orgName: orgNameMap[safeString(b.creator_org_id)] || orgNameMap[safeString(b.approval_org_id)] || '',
      userHrId: b.user_hr_id,
      creatorType: b.creator_type || 'user',
      creatorName: b.creator_type === 'admin' ? (adminMap[b.creator_admin_id] || localeCopy.copy_c01a9aef59) : (applicant.name || (userMap[b.user_hr_id] && userMap[b.user_hr_id].name) || localeCopy.copy_e075eae47d),
      creatorLabel: b.creator_type === 'admin' ? '管理员创建' : '用户申请',
      userName: b.creator_type === 'admin' ? (adminMap[b.creator_admin_id] || localeCopy.copy_c01a9aef59) : (applicant.name || (userMap[b.user_hr_id] && userMap[b.user_hr_id].name) || localeCopy.copy_e075eae47d),
      userDept: applicant.department,
      userIdentity: applicant.identity,
      userWorkGroup: applicant.workGroup,
      creatorAssignmentId: applicant.assignmentId,
      creatorAssignmentLabel: b.creator_type === 'admin'
        ? ''
        : (applicant.assignmentLabel || localeCopy.historicalAssignmentMissing),
      title: b.title,
      description: b.description,
      timeStart: b.time_start,
      timeEnd: b.time_end,
      status: b.status,
      approverHrId: b.approver_hr_id,
      approvalComment: b.approval_comment,
      createdAt: b.created_at,
      approvalProgress: (b.approval_flow_id && b.approval_total_steps > 0) ? {
        flowId: b.approval_flow_id,
        currentStep: b.approval_current_step,
        totalSteps: b.approval_total_steps,
        isApproved: b.approval_current_step >= b.approval_total_steps,
        isRejected: b.approval_current_step < 0,
        rejectStep: b.approval_reject_step,
        snapshots: (() => {
          try { return b.approval_snapshots_json ? JSON.parse(b.approval_snapshots_json) : []; }
          catch (_) { return []; }
        })()
      } : null
      };
    });

    // ── Batch-resolve approver names from snapshots ──
    const allSnapshotHrIds = new Set();
    for (const item of list) {
      if (item.approvalProgress && item.approvalProgress.snapshots) {
        for (const snap of item.approvalProgress.snapshots) {
          if (snap.approverHrId) allSnapshotHrIds.add(snap.approverHrId);
        }
      }
    }
    if (allSnapshotHrIds.size) {
      try {
        const snapshotHrIds = [...allSnapshotHrIds];
        const approverPlaceholders = snapshotHrIds.map(() => '?').join(',');
        const [approverHrList] = await pool.query(
          `SELECT id, name FROM hr_info WHERE id IN (${approverPlaceholders})`,
          snapshotHrIds
        );
        const approverNameMap = {};
        (approverHrList || []).forEach(h => { approverNameMap[h.id] = h.name || ''; });
        for (const item of list) {
          if (item.approvalProgress && item.approvalProgress.snapshots) {
            for (const snap of item.approvalProgress.snapshots) {
              snap.approverName = snap.approverName || approverNameMap[snap.approverHrId] || '';
            }
          }
        }
      } catch (_) {}
    }

    // ── 流程型借用只读取创建时固化的流程快照 ──
    const allFlowBookings = list.filter(lb => lb.approvalProgress && lb.approvalProgress.flowId);
    const bookingMap = new Map(bookings.map(booking => [booking.id, booking]));
    for (const listBooking of allFlowBookings) {
      const booking = bookingMap.get(listBooking.id);
      const flowSteps = booking ? venueApprovalMultiFlow.getSnapshotFlowSteps(
        booking,
        booking.approval_org_id,
        listBooking.approvalProgress.flowId
      ) : [];
      listBooking.approvalProgress.flowSteps = flowSteps;
      listBooking.approvalProgress.flowSnapshotAvailable = flowSteps.length > 0;
    }

    // 管理端只按管理员身份判断，不复用同一微信的普通用户人事身份。
    const adminActor = {
      type: 'admin',
      id: safeString(admin.id),
      personId: safeString(req.authContext && req.authContext.personId),
      adminGrantId: safeString(req.authContext && req.authContext.adminGrantId),
      contextId: safeString(req.authContext && req.authContext.contextId),
      organizationId: orgId,
      name: safeString(admin.name),
      profile: admin
    };
    for (const listBooking of allFlowBookings) {
      if (listBooking.status !== 'pending') continue;
      const booking = bookingMap.get(listBooking.id);
      // 跨组织可见记录只读：仅当当前组织为审批组织时才计算审批资格
      if (!booking || safeString(booking.approval_org_id) !== orgId) {
        listBooking.userCanApprove = false;
        continue;
      }
      const authorization = await venueApprovalMultiFlow.evaluateActorEligibility(booking, adminActor, orgId);
      listBooking.userCanApprove = authorization.ok;
      if (!authorization.ok && authorization.reason === venueApprovalMultiFlow.REASONS.FLOW_SNAPSHOT_MISSING) {
        listBooking.approvalBlockedReason = authorization.reason;
      }
    }

    // 旧规则待办也复用写接口授权，避免列表显示可审批但提交时被拒绝。
    for (const lb of list) {
      if (lb.status === 'pending' && lb.userCanApprove === undefined
        && lb.visibility === 'details'
        && !(lb.approvalProgress && lb.approvalProgress.flowId)) {
        const booking = bookingMap.get(lb.id);
        if (!booking || safeString(lb.approvalOrgId) !== orgId) {
          lb.userCanApprove = false;
        } else {
          const authorization = await canReviewVenueBooking(req, booking);
          lb.userCanApprove = Boolean(authorization.ok);
        }
      }
    }

    res.json({ status: 'success', bookings: list });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

router.post('/approveVenueBooking', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_62d2cac4df });
    const comment = safeString(req.body.comment);
    const orgId = await getCurrentOrgId();
    await conn.beginTransaction();
    const booking = await venueBookingModel.getByIdForUpdate(id, conn);
    if (!booking || booking.approval_org_id !== orgId) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_3508043e2a });
    }
    if (booking.status !== 'pending') {
      await conn.rollback();
      return res.json({ status: 'success', message: localeCopy.copy_3b95420d79, bookingStatus: booking.status, idempotent: true });
    }

    // 流程型借用只能由多流程端点处理。旧端点缺少分支状态，禁止继续按全局步数推进。
    if (isFlowManagedBooking(booking)) {
      await conn.rollback();
      return rejectLegacyFlowEndpoint(req, res);
    }

    const review = await canReviewVenueBooking(req, booking);
    if (!review.ok) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: review.reason || localeCopy.copy_6b48c1ab98 });
    }

    // Legacy approval
    const approvedAt = new Date();
    const bookingTimeEnd = new Date(booking.time_end);
    const approverId = review.hrId || (review.admin && review.admin.id);

    // If approved after booking end, cancel instead
    if (approvedAt > bookingTimeEnd) {
      await venueBookingModel.updateStatus(id, 'cancelled', approverId, '审批时借用已结束，自动取消', conn, review.actor);
      await createVenueBookingStatusNotification(
        booking, 'booking_cancelled', '场地借用已自动取消',
        '您申请的「' + (booking.title || localeCopy.copy_592351d93c) + localeCopy.copy_7b831c34ee, conn
      );
      await conn.commit();
      return res.json({ status: 'expired', message: localeCopy.copy_aa20a1e7b8 });
    }

    // 审批发生在借用开始前时保留申请人原定开始；仅已迟于原开始时才收窄到审批时刻。
    const effectiveTimeStart = effectiveBookingStart(booking.time_start, approvedAt);
    await venueBookingModel.updateTimeStart(id, toMysqlUtc(effectiveTimeStart), conn);

    const timeStart = toMysqlUtc(effectiveTimeStart);
    const timeEnd = toMysqlUtc(new Date(booking.time_end));
    const conflict = await venueBookingModel.findConflict(booking.venue_id, timeStart, timeEnd, id, conn, true);
    if (conflict) {
      await conn.rollback();
      return res.json({ status: 'conflict', message: localeCopy.copy_dcd1184a46 });
    }
    await venueBookingModel.updateStatus(id, 'approved', approverId, comment, conn, review.actor);
    const venueName = booking.venue_name || '';
    await createVenueBookingStatusNotification(
      booking, 'booking_approved', '场地借用已通过',
      '您申请的「' + (booking.title || localeCopy.copy_592351d93c) + '」' + (venueName ? '（' + venueName + '）' : '') + localeCopy.copy_71ff2a4a29, conn
    );
    await conn.commit();

    // Clear old pending_approval notifications + notify submitter
    await notificationModel.deleteByTarget('booking', id).catch(function(error) {
      console.error('[venueAdmin] pending notification cleanup failed:', error.message);
    });
    res.json({ status: 'success', message: localeCopy.copy_a453f693a6 });
  } catch (e) {
    await conn.rollback();
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

router.post('/rejectVenueBooking', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_62d2cac4df });
    const comment = safeString(req.body.comment);
    const orgId = await getCurrentOrgId();
    await conn.beginTransaction();
    const booking = await venueBookingModel.getByIdForUpdate(id, conn);
    if (!booking || booking.approval_org_id !== orgId) {
      await conn.rollback();
      return res.json({ status: 'not_found', message: localeCopy.copy_3508043e2a });
    }
    if (booking.status !== 'pending') {
      await conn.rollback();
      return res.json({ status: 'success', message: localeCopy.copy_3b95420d79, bookingStatus: booking.status, idempotent: true });
    }

    // 流程型借用只能由多流程端点处理，避免旧驳回接口绕过当前分支与岗位授权。
    if (isFlowManagedBooking(booking)) {
      await conn.rollback();
      return rejectLegacyFlowEndpoint(req, res);
    }

    const review = await canReviewVenueBooking(req, booking);
    if (!review.ok) {
      await conn.rollback();
      return res.json({ status: 'forbidden', message: review.reason || localeCopy.copy_6b48c1ab98 });
    }

    await venueBookingModel.updateStatus(
      id,
      'rejected',
      review.hrId || (review.admin && review.admin.id),
      comment,
      conn,
      review.actor
    );
    const venueNameRej = booking.venue_name || '';
    await createVenueBookingStatusNotification(
      booking, 'booking_rejected', '场地借用被驳回',
      '您申请的「' + (booking.title || localeCopy.copy_592351d93c) + '」' + (venueNameRej ? '（' + venueNameRej + '）' : '') + localeCopy.copy_f553985be3 +
        (comment ? '，原因：' + comment : ''), conn
    );
    await conn.commit();

    // Clear old pending_approval notifications + notify submitter
    await notificationModel.deleteByTarget('booking', id).catch(function(error) {
      console.error('[venueAdmin] pending notification cleanup failed:', error.message);
    });
    res.json({ status: 'success', message: localeCopy.copy_c7b826b0c0 });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    res.json({ status: 'error', message: safeString(e.message) });
  } finally {
    conn.release();
  }
});

// 旧的管理员直通端点会绕过流程权限，保留明确的升级响应而不再执行写入。
router.post(['/approveVenueBookingAdmin', '/rejectVenueBookingAdmin'], (req, res) => {
  return rejectLegacyFlowEndpoint(req, res);
});

// ═══════════════════════════════════════════════════
// Booking Purposes (事由管理)
// ═══════════════════════════════════════════════════

// listVenueBookingPurposes (public — any authenticated user can read purposes)
router.post('/listVenueBookingPurposes', async (req, res) => {
  try {
    if (!getAuthenticatedContext(req)) return res.json({ status: 'forbidden', message: localeCopy.copy_20ca49e5e7 });
    const purposes = await venueBookingPurposeModel.getAll();
    res.json({ status: 'success', purposes });
  } catch (e) {
    console.error('[venue:listVenueBookingPurposes]', req.requestId || '-', e);
    res.json({ status: 'error', message: localeCopy.copy_e52119b17e });
  }
});

// saveVenueBookingPurpose
router.post('/saveVenueBookingPurpose', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id) || generateId();
    const text = safeString(req.body.text).trim();
    if (!text) return res.json({ status: 'invalid_params', message: localeCopy.copy_fdb45fb38f });
    if (!isBookingPurposeLengthValid(text)) {
      return res.json({ status: 'invalid_params', message: localeCopy.bookingPurposeTooLong });
    }
    const data = { text, sortOrder: parseInt(req.body.sortOrder) || 1 };
    const existing = await venueBookingPurposeModel.getById(id);
    if (existing) {
      await venueBookingPurposeModel.update(id, data);
    } else {
      await venueBookingPurposeModel.create(id, data);
    }
    res.json({
      status: 'success',
      id,
      message: existing ? localeCopy.bookingPurposeUpdated : localeCopy.bookingPurposeCreated
    });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.json({ status: 'duplicate', message: localeCopy.copy_09f81fd1db });
    console.error('[venue:saveVenueBookingPurpose]', req.requestId || '-', e);
    res.json({ status: 'error', message: localeCopy.copy_215e3c57da });
  }
});

// deleteVenueBookingPurpose
router.post('/deleteVenueBookingPurpose', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_5869ec3d99 });
    const existing = await venueBookingPurposeModel.getById(id);
    if (existing) {
      // 历史结构未保存 purpose_id，只能用借用记录中的事由文本快照判定引用。
      const [referenceRows] = await pool.query(
        'SELECT 1 FROM venue_bookings WHERE title = ? LIMIT 1',
        [existing.text]
      );
      if (referenceRows.length) {
        return res.json({ status: 'conflict', message: localeCopy.bookingPurposeReferenced });
      }
    }
    await venueBookingPurposeModel.remove(id);
    res.json({ status: 'success', message: localeCopy.copy_f95e1a0218 });
  } catch (e) {
    if (e && (e.code === 'ER_ROW_IS_REFERENCED' || e.code === 'ER_ROW_IS_REFERENCED_2')) {
      return res.json({ status: 'conflict', message: localeCopy.bookingPurposeReferenced });
    }
    res.json({ status: 'error', message: localeCopy.bookingPurposeDeleteFailed });
  }
});

module.exports = router;
