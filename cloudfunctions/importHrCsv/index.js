const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 100;
const PARALLEL = 10;

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function firstValue(row, fields) {
  for (const field of fields) {
    const value = safeString(row && row[field]);
    if (value) return value;
  }
  return '';
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
}

async function getAllRecords(collectionName) {
  const { total } = await db.collection(collectionName).count();
  if (total === 0) return [];

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const promises = [];
  for (let i = 0; i < totalPages; i++) {
    promises.push(
      db.collection(collectionName).skip(i * PAGE_SIZE).limit(PAGE_SIZE).get()
    );
  }
  const results = await Promise.all(promises);
  return results.flatMap((res) => res.data || []);
}

async function createOrgRecord(collectionName, name) {
  const addRes = await db.collection(collectionName).add({
    data: { name, description: '', createdAt: db.serverDate(), updatedAt: db.serverDate() }
  });
  return { _id: addRes._id, name };
}

async function createWorkGroupRecord(name, departmentId) {
  const addRes = await db.collection('work_groups').add({
    data: {
      name,
      departmentId,
      description: '',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return { _id: addRes._id, name };
}

function parseCsv(content) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;
  const text = String(content || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current);
      if (row.some((item) => safeString(item))) rows.push(row);
      row = [];
      current = '';
      continue;
    }
    current += char;
  }
  if (current || row.length) {
    row.push(current);
    if (row.some((item) => safeString(item))) rows.push(row);
  }
  return rows;
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '没有管理权限' };

  const rows = parseCsv(String(event.csvContent || ''));
  if (rows.length < 2) return { status: 'invalid_params', message: 'CSV 至少需要表头和一行数据' };

  const headers = rows[0].map((item) => safeString(item));
  const startIndex = Math.max(1, Number(event.startIndex || 1));
  const batchSize = Math.max(1, Math.min(Number(event.batchSize || 50), 100));
  const endIndex = Math.min(rows.length, startIndex + batchSize);

  // 预加载所有参考数据和已有人员记录
  const [allDepts, allIdentities, allWorkGroups, allHrInfo] = await Promise.all([
    getAllRecords('departments'),
    getAllRecords('identities'),
    getAllRecords('work_groups'),
    getAllRecords('hr_info')
  ]);

  // 构建内存查找表
  const deptMap = new Map();
  allDepts.forEach((d) => deptMap.set(d.name, d._id));

  const identityMap = new Map();
  allIdentities.forEach((d) => identityMap.set(d.name, d._id));

  const workGroupMap = new Map();
  allWorkGroups.forEach((w) => workGroupMap.set(`${w.name}::${w.departmentId}`, w._id));

  const hrInfoMap = new Map();
  allHrInfo.forEach((h) => hrInfoMap.set(h.studentId, h._id));

  const targetRows = rows.slice(startIndex, endIndex);
  const parsedRows = [];

  for (let i = 0; i < targetRows.length; i++) {
    const row = targetRows[i];
    const doc = {};
    headers.forEach((header, index) => {
      if (header) doc[header] = safeString(row[index]);
    });

    const name = firstValue(doc, ['name', '姓名']);
    const studentId = firstValue(doc, ['studentId', '学号']);
    if (!studentId) continue;

    const departmentName = firstValue(doc, ['departmentName', 'department', '所属部门', '部门', '学院']);
    const identityName = firstValue(doc, ['identityName', 'identity', '身份', '身份类别']);
    const workGroupName = firstValue(doc, ['workGroupName', 'workGroup', '工作分工（职能组）', '工作分工', '职能组']);

    parsedRows.push({ name, studentId, departmentName, identityName, workGroupName });
  }

  // 找出需要新建的部门/身份/职能组（去重）
  const newDeptNames = new Set();
  const newIdentityNames = new Set();
  const newWorkGroupKeys = new Set();

  for (const row of parsedRows) {
    if (row.departmentName && !deptMap.has(row.departmentName)) {
      newDeptNames.add(row.departmentName);
    }
    if (row.identityName && !identityMap.has(row.identityName)) {
      newIdentityNames.add(row.identityName);
    }
    if (row.workGroupName && row.departmentName) {
      const deptId = deptMap.get(row.departmentName);
      const key = `${row.workGroupName}::${deptId || ''}`;
      if (deptId && !workGroupMap.has(key)) {
        newWorkGroupKeys.add(key);
      }
    }
  }

  // 批量创建新的部门
  for (const name of newDeptNames) {
    const record = await createOrgRecord('departments', name);
    deptMap.set(name, record._id);
  }

  // 批量创建新的身份
  for (const name of newIdentityNames) {
    const record = await createOrgRecord('identities', name);
    identityMap.set(name, record._id);
  }

  // 批量创建新的职能组
  for (const key of newWorkGroupKeys) {
    const [name, departmentId] = key.split('::');
    const record = await createWorkGroupRecord(name, departmentId);
    workGroupMap.set(key, record._id);
  }

  // 并行处理所有记录
  let count = 0;
  for (let i = 0; i < parsedRows.length; i += PARALLEL) {
    const chunk = parsedRows.slice(i, i + PARALLEL);
    const results = await Promise.all(chunk.map(async (row) => {
      const departmentId = row.departmentName ? deptMap.get(row.departmentName) || '' : '';
      const identityId = row.identityName ? identityMap.get(row.identityName) || '' : '';
      let workGroupId = '';
      if (row.workGroupName && departmentId) {
        workGroupId = workGroupMap.get(`${row.workGroupName}::${departmentId}`) || '';
      }

      const basePayload = {
        name: row.name,
        studentId: row.studentId,
        departmentId,
        identityId,
        workGroupId,
        updatedAt: db.serverDate()
      };

      const existingId = hrInfoMap.get(row.studentId);

      if (existingId) {
        // 更新时清除旧字段
        await db.collection('hr_info').doc(existingId).update({
          data: {
            ...basePayload,
            department: _.remove(),
            departmentName: _.remove(),
            identity: _.remove(),
            identityName: _.remove(),
            workGroup: _.remove(),
            workGroupName: _.remove(),
            所属部门: _.remove(),
            部门: _.remove(),
            学院: _.remove(),
            身份: _.remove(),
            身份类别: _.remove(),
            工作分工: _.remove(),
            职能组: _.remove(),
            '工作分工（职能组）': _.remove()
          }
        });
        return 'updated';
      } else {
        await db.collection('hr_info').add({
          data: {
            ...basePayload,
            createdAt: db.serverDate()
          }
        });
        return 'created';
      }
    }));

    count += results.length;
  }

  return {
    status: 'success',
    count,
    totalRows: rows.length - 1,
    nextIndex: endIndex,
    hasMore: endIndex < rows.length
  };
};
