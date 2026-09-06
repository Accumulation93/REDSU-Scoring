'use strict';

const pool = require('../../../config/db');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const { generateId } = require('../../../utils/helpers');
const { lockPersonDeletionBarrier } = require('../../../core/models/hrMemberDeletion');

function normalizeAssignmentIds(value) {
  if (!Array.isArray(value) || value.length > 1000
    || value.some(id => typeof id !== 'string' || !id.trim() || id.trim().length > 64)) return null;
  return [...new Set(value.map(id => id.trim()))].sort();
}

// 白名单投影不读取或返回学号；三个分类来自同一个岗位。
const candidateSelect = `SELECT ma.id AS assignmentId, om.person_id AS personId,
    p.name, ma.assignment_kind AS assignmentNature,
    ma.department_id AS departmentId, d.name AS departmentName,
    ma.identity_id AS identityCategoryId, i.name AS identityCategoryName,
    ma.work_group_id AS workGroupId, wg.name AS workGroupName
  FROM membership_assignments ma
  JOIN organization_memberships om ON om.id = ma.membership_id AND om.org_id = ma.org_id
  JOIN persons p ON p.id = om.person_id
  JOIN departments d ON d.id = ma.department_id AND d.org_id = ma.org_id
  JOIN identities i ON i.id = ma.identity_id AND i.org_id = ma.org_id
  LEFT JOIN work_groups wg ON wg.id = ma.work_group_id AND wg.org_id = ma.org_id
  WHERE ma.org_id = ? AND ma.status = 'active' AND om.status = 'active' AND p.status = 'active'`;

function presentCandidate(row) {
  return Object.assign({}, row, {
    assignmentLabel: [row.identityCategoryName, row.departmentName, row.workGroupName].filter(Boolean).join(' · ')
  });
}

async function listCandidates() {
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query(candidateSelect + ' ORDER BY p.name, ma.id', [orgId]);
  return rows.map(presentCandidate);
}

async function listGrants() {
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query(
    `SELECT g.stamp_id AS stampId, g.assignment_id AS assignmentId, g.person_id AS personId,
        p.name, d.name AS departmentName, i.name AS identityCategoryName, wg.name AS workGroupName,
        (ma.status = 'active' AND om.status = 'active' AND p.status = 'active'
          AND om.person_id = g.person_id) AS available
      FROM stamp_assignment_grants g
      JOIN stamps s ON s.id = g.stamp_id AND s.org_id = g.org_id
      JOIN membership_assignments ma ON ma.id = g.assignment_id AND ma.org_id = g.org_id
      JOIN organization_memberships om ON om.id = ma.membership_id AND om.org_id = g.org_id
      JOIN persons p ON p.id = g.person_id
      LEFT JOIN departments d ON d.id = ma.department_id AND d.org_id = g.org_id
      LEFT JOIN identities i ON i.id = ma.identity_id AND i.org_id = g.org_id
      LEFT JOIN work_groups wg ON wg.id = ma.work_group_id AND wg.org_id = g.org_id
      WHERE g.org_id = ? ORDER BY p.name, ma.id`, [orgId]);
  return rows.map(row => presentCandidate(Object.assign({}, row, { available: Number(row.available) === 1 })));
}

async function replaceForStamp(stampId, value) {
  const assignmentIds = normalizeAssignmentIds(value);
  if (!assignmentIds || typeof stampId !== 'string' || !stampId || stampId.length > 64) return { status: 'invalid_params' };
  const orgId = await getCurrentOrgId();
  return pool.withTransaction(async connection => {
    let candidates = [];
    if (assignmentIds.length) {
      const marks = assignmentIds.map(() => '?').join(',');
      const [initial] = await connection.query(candidateSelect + ` AND ma.id IN (${marks})`, [orgId, ...assignmentIds]);
      if (initial.length !== assignmentIds.length) return { status: 'assignment_unavailable' };
      // 与人员删除共用屏障，再锁岗位并复核，防止检查后离任或删除。
      for (const personId of [...new Set(initial.map(row => row.personId))].sort()) {
        if (!await lockPersonDeletionBarrier(connection, personId)) return { status: 'assignment_unavailable' };
      }
      const [locked] = await connection.query(candidateSelect + ` AND ma.id IN (${marks}) ORDER BY ma.id FOR UPDATE`, [orgId, ...assignmentIds]);
      if (locked.length !== assignmentIds.length
        || locked.some(row => !initial.some(old => old.assignmentId === row.assignmentId && old.personId === row.personId))) {
        return { status: 'assignment_unavailable' };
      }
      candidates = locked;
    }
    const [stamps] = await connection.query('SELECT id FROM stamps WHERE id = ? AND org_id = ? FOR UPDATE', [stampId, orgId]);
    if (!stamps.length) return { status: 'stamp_not_found' };
    await connection.query('DELETE FROM stamp_assignment_grants WHERE stamp_id = ? AND org_id = ?', [stampId, orgId]);
    for (const candidate of candidates) {
      await connection.query(
        'INSERT INTO stamp_assignment_grants (id, org_id, stamp_id, assignment_id, person_id) VALUES (?, ?, ?, ?, ?)',
        [generateId(), orgId, stampId, candidate.assignmentId, candidate.personId]);
    }
    return { status: 'success' };
  });
}

async function getAuthorizedStamps(assignment, stampIds, connection) {
  const actor = assignment || {};
  if (!actor.assignment_id || !actor.person_id) return [];
  const orgId = await getCurrentOrgId();
  if (actor.org_id !== orgId) return [];
  const ids = stampIds === undefined ? null : normalizeAssignmentIds(stampIds);
  if (stampIds !== undefined && (!ids || !ids.length)) return [];
  const params = [orgId, actor.assignment_id, actor.person_id];
  const clause = ids ? ` AND s.id IN (${ids.map(() => '?').join(',')})` : '';
  if (ids) params.push(...ids);
  const [rows] = await (connection || pool).query(
    `SELECT s.id, s.name, s.image_data
      FROM stamps s
      JOIN stamp_assignment_grants g ON g.stamp_id = s.id AND g.org_id = s.org_id
      JOIN membership_assignments ma ON ma.id = g.assignment_id AND ma.org_id = g.org_id AND ma.status = 'active'
      JOIN organization_memberships om ON om.id = ma.membership_id AND om.org_id = g.org_id
        AND om.person_id = g.person_id AND om.status = 'active'
      JOIN persons p ON p.id = g.person_id AND p.status = 'active'
      WHERE s.org_id = ? AND g.assignment_id = ? AND g.person_id = ?${clause}
      ORDER BY s.id${connection ? ' FOR UPDATE' : ''}`, params);
  return rows;
}

module.exports = { normalizeAssignmentIds, listCandidates, listGrants, replaceForStamp, getAuthorizedStamps };
