const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const FIELD_NAME = '姓名';
const FIELD_STUDENT_ID = '学号';
const FIELD_DEPARTMENT = '所属部门';
const FIELD_IDENTITY = '身份';
const FIELD_WORK_GROUP = '工作分工（职能组）';
const DEFAULT_WORK_GROUP = '未分组';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  const date = value instanceof Date
    ? value
    : (value && typeof value.toDate === 'function' ? value.toDate() : new Date(value));
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
  const timePart = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ].join(':');
  return `${datePart} ${timePart}`;
}

function normalizeMember(record = {}) {
  return {
    id: safeString(record._id),
    name: safeString(record.name || record[FIELD_NAME]),
    studentId: safeString(record.studentId || record[FIELD_STUDENT_ID]),
    department: safeString(record.department || record[FIELD_DEPARTMENT]),
    identity: safeString(record.identity || record[FIELD_IDENTITY]),
    workGroup: safeString(record.workGroup || record[FIELD_WORK_GROUP]) || DEFAULT_WORK_GROUP
  };
}

function normalizeRuleClause(rawClause = {}) {
  const templateConfigs = Array.isArray(rawClause.templateConfigs)
    ? rawClause.templateConfigs
    : [];
  return {
    scopeType: safeString(rawClause.scopeType),
    targetIdentity: safeString(rawClause.targetIdentity),
    templateConfigs: templateConfigs.filter((item) => safeString(item.templateId))
  };
}

function buildTargetBase(record = {}, hrMap) {
  const hrMember = hrMap.get(safeString(record.targetId));
  return {
    targetId: hrMember ? hrMember.id : safeString(record.targetId),
    name: hrMember ? hrMember.name : safeString(record.targetName),
    studentId: hrMember ? hrMember.studentId : safeString(record.targetStudentId),
    department: hrMember ? hrMember.department : safeString(record.targetDepartment),
    identity: hrMember ? hrMember.identity : safeString(record.targetIdentity),
    workGroup: hrMember ? hrMember.workGroup : (safeString(record.targetWorkGroup) || DEFAULT_WORK_GROUP)
  };
}

function getMemberRuleKey(member) {
  return `${safeString(member.department)}::${safeString(member.identity)}`;
}

function getScorerKey(member) {
  return safeString(member.studentId) || safeString(member.id);
}

function matchesClauseTarget(target, scorer, clause) {
  const scopeType = safeString(clause.scopeType);
  const targetIdentity = safeString(clause.targetIdentity);
  if (scopeType === 'same_department_identity') {
    return target.department === scorer.department && target.identity === targetIdentity;
  }
  if (scopeType === 'same_department_all') {
    return target.department === scorer.department;
  }
  if (scopeType === 'same_work_group_identity') {
    return target.department === scorer.department
      && target.workGroup === scorer.workGroup
      && target.identity === targetIdentity;
  }
  if (scopeType === 'same_work_group_all') {
    return target.department === scorer.department && target.workGroup === scorer.workGroup;
  }
  if (scopeType === 'identity_only') {
    return target.identity === targetIdentity;
  }
  if (scopeType === 'all_people') {
    return true;
  }
  return false;
}

function buildCompletionBoard(rows, field) {
  const boardMap = new Map();
  rows
    .filter((item) => Number(item.expectedScorerCount || 0) > 0)
    .forEach((item) => {
      const key = safeString(item[field]) || '未设置';
      if (!boardMap.has(key)) {
        boardMap.set(key, {
          groupName: key,
          memberCount: 0,
          completedCount: 0,
          pendingCount: 0,
          expectedScorerCount: 0,
          submittedScorerCount: 0
        });
      }
      const row = boardMap.get(key);
      row.memberCount += 1;
      row.expectedScorerCount += toNumber(item.expectedScorerCount, 0);
      row.submittedScorerCount += toNumber(item.submittedScorerCount, 0);
      if (toNumber(item.pendingScorerCount, 0) > 0) {
        row.pendingCount += 1;
      } else {
        row.completedCount += 1;
      }
    });

  return Array.from(boardMap.values()).map((item) => ({
    ...item,
    completionRate: item.memberCount
      ? Number(((item.completedCount / item.memberCount) * 100).toFixed(2))
      : 0
  }));
}

function applyFiltersToRows(payload, filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);
  const isAll = (value) => !value || value === '全部';
  const matches = (row) => {
    if (!isAll(department) && safeString(row.department) !== department) {
      return false;
    }
    if (!isAll(identity) && safeString(row.identity) !== identity) {
      return false;
    }
    if (!isAll(workGroup) && safeString(row.workGroup || DEFAULT_WORK_GROUP) !== workGroup) {
      return false;
    }
    return true;
  };

  const overviewRows = (payload.overviewRows || []).filter(matches);
  const calculationRows = (payload.calculationRows || []).filter(matches);
  const detailRows = (payload.detailRows || []).filter(matches);
  const recordRows = (payload.recordRows || []).filter(matches);
  const completionRows = overviewRows.filter((item) => Number(item.expectedScorerCount || 0) > 0);

  return {
    ...payload,
    overviewRows,
    calculationRows,
    detailRows,
    recordRows,
    completionBoards: {
      departments: buildCompletionBoard(completionRows, 'department'),
      identities: buildCompletionBoard(completionRows, 'identity'),
      workGroups: buildCompletionBoard(completionRows, 'workGroup')
    }
  };
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();
  return res.data[0] || null;
}

async function buildScoreResultPayload(activityId) {
  const [activityRes, hrRes, ruleRes, recordRes] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    db.collection('hr_info').limit(1000).get(),
    db.collection('rate_target_rules').where({ activityId }).limit(1000).get(),
    db.collection('score_records').where({ activityId }).limit(1000).get()
  ]);

  const activity = activityRes.data;
  if (!activity) {
    return {
      status: 'activity_not_found',
      message: '未找到对应的评分活动'
    };
  }

  const hrList = (hrRes.data || []).map((item) => normalizeMember(item));
  const hrMap = new Map(hrList.map((item) => [item.id, item]));
  const rules = (ruleRes.data || []).map((item) => ({
    ...item,
    scorerKey: safeString(item.scorerKey),
    scorerDepartment: safeString(item.scorerDepartment),
    scorerIdentity: safeString(item.scorerIdentity),
    clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause)) : []
  }));
  const records = recordRes.data || [];

  const ruleById = new Map(rules.map((item) => [safeString(item._id), item]));
  const scorerMembersByRuleKey = hrList.reduce((map, member) => {
    const key = getMemberRuleKey(member);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(member);
    return map;
  }, new Map());

  const expectedPairMap = new Map();
  const targetPendingMap = new Map();

  rules.forEach((rule) => {
    const scorerList = scorerMembersByRuleKey.get(rule.scorerKey) || [];
    if (!scorerList.length) {
      return;
    }

    rule.clauses
      .filter((clause) => clause.templateConfigs.length > 0)
      .forEach((clause) => {
        scorerList.forEach((scorer) => {
          hrList.forEach((target) => {
            if (!matchesClauseTarget(target, scorer, clause)) {
              return;
            }
            const scorerKey = getScorerKey(scorer);
            if (!scorerKey || !target.id) {
              return;
            }
            const pairKey = `${scorerKey}::${target.id}`;
            if (!expectedPairMap.has(pairKey)) {
              expectedPairMap.set(pairKey, {
                scorerKey,
                scorerName: scorer.name,
                targetId: target.id
              });
            }
          });
        });
      });
  });

  expectedPairMap.forEach((pair) => {
    if (!targetPendingMap.has(pair.targetId)) {
      targetPendingMap.set(pair.targetId, {
        expectedScorerKeys: new Set(),
        submittedScorerKeys: new Set()
      });
    }
    targetPendingMap.get(pair.targetId).expectedScorerKeys.add(pair.scorerKey);
  });

  records.forEach((record) => {
    const scorerKey = safeString(record.scorerStudentId) || safeString(record.scorerId);
    const targetId = safeString(record.targetId);
    if (!scorerKey || !targetId) {
      return;
    }
    if (!targetPendingMap.has(targetId)) {
      targetPendingMap.set(targetId, {
        expectedScorerKeys: new Set(),
        submittedScorerKeys: new Set()
      });
    }
    targetPendingMap.get(targetId).submittedScorerKeys.add(scorerKey);
  });

  const calculationMap = new Map();
  const memberScoreMap = new Map();
  const detailRows = [];
  const recordRows = [];

  records.forEach((record) => {
    const targetBase = buildTargetBase(record, hrMap);
    if (!targetBase.targetId) {
      return;
    }

    const rule = ruleById.get(safeString(record.ruleId)) || {};
    const scorerDepartment = safeString(rule.scorerDepartment);
    const scorerIdentity = safeString(rule.scorerIdentity || record.scorerIdentity);
    const scorerCategoryLabel = [scorerDepartment, scorerIdentity].filter(Boolean).join(' / ') || '未匹配评分人类别';
    const templateScores = Array.isArray(record.templateScores) ? record.templateScores : [];
    const templateSummary = templateScores
      .map((item) => `${safeString(item.templateName)} × ${toNumber(item.weight, 0)}`)
      .filter(Boolean)
      .join('；');

    recordRows.push({
      recordId: safeString(record._id),
      scorerName: safeString(record.scorerName),
      scorerStudentId: safeString(record.scorerStudentId),
      scorerCategoryLabel,
      name: targetBase.name,
      studentId: targetBase.studentId,
      department: targetBase.department,
      identity: targetBase.identity,
      workGroup: targetBase.workGroup || DEFAULT_WORK_GROUP,
      templateSummary,
      rawTotalScore: toNumber(record.rawTotalScore, 0),
      weightedTotalScore: toNumber(record.weightedTotalScore, 0),
      submittedAt: formatDate(record.submittedAt)
    });

    templateScores.forEach((templateItem) => {
      const templateId = safeString(templateItem.templateId);
      const templateName = safeString(templateItem.templateName);
      const weight = toNumber(templateItem.weight, 0);
      const templateScore = toNumber(templateItem.score, 0);
      const weightedScore = toNumber(templateItem.weightedScore, templateScore * weight);
      const groupKey = [targetBase.targetId, scorerCategoryLabel, templateId].join('||');

      if (!calculationMap.has(groupKey)) {
        calculationMap.set(groupKey, {
          targetId: targetBase.targetId,
          name: targetBase.name,
          studentId: targetBase.studentId,
          department: targetBase.department,
          identity: targetBase.identity,
          workGroup: targetBase.workGroup || DEFAULT_WORK_GROUP,
          scorerCategoryLabel,
          templateId,
          templateName,
          weight,
          recordCount: 0,
          sumScore: 0
        });
      }

      const bucket = calculationMap.get(groupKey);
      bucket.recordCount += 1;
      bucket.sumScore += templateScore;

      detailRows.push({
        ...targetBase,
        scorerName: safeString(record.scorerName),
        scorerStudentId: safeString(record.scorerStudentId),
        scorerCategoryLabel,
        templateName,
        weight,
        templateScore,
        weightedScore,
        finalRecordScore: toNumber(record.weightedTotalScore, 0),
        submittedAt: formatDate(record.submittedAt)
      });
    });
  });

  const calculationRows = Array.from(calculationMap.values()).map((item) => {
    const averageScore = item.recordCount ? item.sumScore / item.recordCount : 0;
    const contributionScore = averageScore * item.weight;
    const stat = memberScoreMap.get(item.targetId) || {
      finalScore: 0,
      scoredRecordCount: 0,
      scoredTemplateCount: 0
    };
    stat.finalScore += contributionScore;
    stat.scoredRecordCount += item.recordCount;
    stat.scoredTemplateCount += 1;
    memberScoreMap.set(item.targetId, stat);

    return {
      targetId: item.targetId,
      name: item.name,
      studentId: item.studentId,
      department: item.department,
      identity: item.identity,
      workGroup: item.workGroup || DEFAULT_WORK_GROUP,
      scorerCategoryLabel: item.scorerCategoryLabel,
      templateName: item.templateName,
      weight: item.weight,
      recordCount: item.recordCount,
      averageScore: Number(averageScore.toFixed(4)),
      contributionScore: Number(contributionScore.toFixed(4))
    };
  });

  const overviewRows = hrList.map((member) => {
    const scoreStat = memberScoreMap.get(member.id) || {};
    const pendingStat = targetPendingMap.get(member.id) || {
      expectedScorerKeys: new Set(),
      submittedScorerKeys: new Set()
    };
    const expectedScorerCount = pendingStat.expectedScorerKeys.size;
    const submittedScorerCount = pendingStat.submittedScorerKeys.size;
    const pendingScorerCount = Math.max(expectedScorerCount - submittedScorerCount, 0);
    const completionRate = expectedScorerCount
      ? Number(((submittedScorerCount / expectedScorerCount) * 100).toFixed(2))
      : 0;

    return {
      id: member.id,
      name: member.name,
      studentId: member.studentId,
      department: member.department,
      identity: member.identity,
      workGroup: member.workGroup || DEFAULT_WORK_GROUP,
      finalScore: Number(toNumber(scoreStat.finalScore, 0).toFixed(4)),
      scoredRecordCount: toNumber(scoreStat.scoredRecordCount, 0),
      scoredTemplateCount: toNumber(scoreStat.scoredTemplateCount, 0),
      expectedScorerCount,
      submittedScorerCount,
      pendingScorerCount,
      completionRate
    };
  });

  return {
    status: 'success',
    activityName: safeString(activity.name),
    overviewRows,
    calculationRows,
    detailRows,
    recordRows,
    completionBoards: {
      departments: buildCompletionBoard(overviewRows, 'department'),
      identities: buildCompletionBoard(overviewRows, 'identity'),
      workGroups: buildCompletionBoard(overviewRows, 'workGroup')
    }
  };
}

function escapeCsvCell(value) {
  const text = String(value == null ? '' : value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(headers, rows) {
  const lines = [headers.map((item) => escapeCsvCell(item.label)).join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((item) => escapeCsvCell(row[item.key])).join(','));
  });
  return `\ufeff${lines.join('\r\n')}`;
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildExcelXml(sheetName, headers, rows) {
  const headerXml = headers.map((item) => (
    `<Cell ss:StyleID="header"><Data ss:Type="String">${escapeXml(item.label)}</Data></Cell>`
  )).join('');
  const rowXml = rows.map((row) => {
    const cells = headers.map((item) => {
      const value = row[item.key];
      const isNumber = typeof value === 'number' && Number.isFinite(value);
      return `<Cell><Data ss:Type="${isNumber ? 'Number' : 'String'}">${escapeXml(value)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#DCEBFF" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${escapeXml(sheetName)}">
  <Table>
   <Row>${headerXml}</Row>
   ${rowXml}
  </Table>
 </Worksheet>
</Workbook>`;
}

function buildReportDefinition(reportType, payload) {
  const baseName = payload.activityName || '评分活动';

  if (reportType === 'detail') {
    return {
      fileName: `${baseName}_评分明细`,
      sheetName: '评分明细',
      headers: [
        { key: 'name', label: '被评分人姓名' },
        { key: 'studentId', label: '被评分人学号' },
        { key: 'department', label: '所属部门' },
        { key: 'identity', label: '身份' },
        { key: 'workGroup', label: '工作分工（职能组）' },
        { key: 'scorerName', label: '评分人姓名' },
        { key: 'scorerStudentId', label: '评分人学号' },
        { key: 'scorerCategoryLabel', label: '评分人类别' },
        { key: 'templateName', label: '模板名称' },
        { key: 'weight', label: '模板权重' },
        { key: 'templateScore', label: '模板得分' },
        { key: 'weightedScore', label: '加权得分' },
        { key: 'finalRecordScore', label: '本次评分总分' },
        { key: 'submittedAt', label: '评分时间' }
      ],
      rows: payload.detailRows
    };
  }

  if (reportType === 'calculation') {
    return {
      fileName: `${baseName}_总分计算表`,
      sheetName: '总分计算表',
      headers: [
        { key: 'name', label: '成员姓名' },
        { key: 'studentId', label: '成员学号' },
        { key: 'department', label: '所属部门' },
        { key: 'identity', label: '身份' },
        { key: 'workGroup', label: '工作分工（职能组）' },
        { key: 'scorerCategoryLabel', label: '评分人类别' },
        { key: 'templateName', label: '模板名称' },
        { key: 'weight', label: '模板权重' },
        { key: 'recordCount', label: '评分份数' },
        { key: 'averageScore', label: '平均分' },
        { key: 'contributionScore', label: '贡献分' }
      ],
      rows: payload.calculationRows
    };
  }

  if (reportType === 'records') {
    return {
      fileName: `${baseName}_评分记录`,
      sheetName: '评分记录',
      headers: [
        { key: 'scorerName', label: '评分人姓名' },
        { key: 'scorerStudentId', label: '评分人学号' },
        { key: 'scorerCategoryLabel', label: '评分人类别' },
        { key: 'name', label: '被评分人姓名' },
        { key: 'studentId', label: '被评分人学号' },
        { key: 'department', label: '所属部门' },
        { key: 'identity', label: '身份' },
        { key: 'workGroup', label: '工作分工（职能组）' },
        { key: 'templateSummary', label: '模板组合' },
        { key: 'rawTotalScore', label: '原始总分' },
        { key: 'weightedTotalScore', label: '加权总分' },
        { key: 'submittedAt', label: '评分时间' }
      ],
      rows: payload.recordRows
    };
  }

  return {
    fileName: `${baseName}_总分速览表`,
    sheetName: '总分速览表',
    headers: [
      { key: 'name', label: '成员姓名' },
      { key: 'studentId', label: '成员学号' },
      { key: 'department', label: '所属部门' },
      { key: 'identity', label: '身份' },
      { key: 'workGroup', label: '工作分工（职能组）' },
      { key: 'finalScore', label: '最终得分' },
      { key: 'expectedScorerCount', label: '应评分人数' },
      { key: 'submittedScorerCount', label: '已评分人数' },
      { key: 'pendingScorerCount', label: '待评分人数' },
      { key: 'completionRate', label: '完成率(%)' }
    ],
    rows: payload.overviewRows
  };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const activityId = safeString(event.activityId);
  const reportType = safeString(event.reportType) || 'overview';
  const format = safeString(event.format) || 'csv';
  const filters = event.filters || {};

  if (!activityId) {
    return {
      status: 'invalid_params',
      message: '请先选择评分活动'
    };
  }

  const operator = await ensureAdmin(openid);
  if (!operator) {
    return {
      status: 'forbidden',
      message: '没有管理权限'
    };
  }

  const payload = await buildScoreResultPayload(activityId);
  if (payload.status !== 'success') {
    return payload;
  }

  const filteredPayload = applyFiltersToRows(payload, filters);
  const report = buildReportDefinition(reportType, filteredPayload);
  const fileContent = format === 'excel'
    ? buildExcelXml(report.sheetName, report.headers, report.rows)
    : buildCsv(report.headers, report.rows);

  return {
    status: 'success',
    fileContent,
    fileName: report.fileName,
    extension: format === 'excel' ? 'xls' : 'csv'
  };
};
