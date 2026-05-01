const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PAGE_SIZE = 100;
const BATCH_SIZE = 50;
const CONCURRENCY = 3;
const CONFIG_ID = 'default';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

const ARCHIVE_SPECS = [
  { source: 'hr_info', history: 'hr_info_history' },
  { source: 'departments', history: 'departments_history' },
  { source: 'identities', history: 'identities_history' },
  { source: 'work_groups', history: 'work_groups_history' },
  { source: 'hr_profile_records', history: 'hr_profile_records_history' },
  { source: 'hr_profile_templates', history: 'hr_profile_templates_history' },
  { source: 'rate_target_rules', history: 'rate_target_rules_history' },
  { source: 'score_activities', history: 'score_activities_history' },
  { source: 'score_records', history: 'score_records_history' },
  { source: 'user_info', history: 'user_info_history' }
];

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

async function removeAllFromCollection(collectionName) {
  const records = await getAllRecords(collectionName);
  if (!records.length) return;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((doc) =>
      db.collection(collectionName).doc(doc._id).remove()
    ));
  }
}

async function archiveCollection(sourceCol, historyCol, orgId) {
  const records = await getAllRecords(sourceCol);
  if (!records.length) return;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((record) => {
      const { _id, ...rest } = record;
      return db.collection(historyCol).doc(_id).set({
        data: { ...rest, originalId: _id, orgId, archivedAt: new Date() }
      });
    }));
  }

  await removeAllFromCollection(sourceCol);
}

async function archiveAdmins(orgId) {
  const records = await getAllRecords('admin_info');
  const toArchive = records.filter((r) => r.adminLevel !== 'root_admin');
  if (!toArchive.length) return;

  for (let i = 0; i < toArchive.length; i += BATCH_SIZE) {
    const batch = toArchive.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((record) => {
      const { _id, ...rest } = record;
      return db.collection('admin_info_history').doc(_id).set({
        data: { ...rest, originalId: _id, orgId, archivedAt: new Date() }
      });
    }));
  }

  for (let i = 0; i < toArchive.length; i += BATCH_SIZE) {
    const batch = toArchive.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((doc) =>
      db.collection('admin_info').doc(doc._id).remove()
    ));
  }
}

async function restoreCollection(historyCol, targetCol, orgId) {
  const records = await getAllRecords(historyCol);
  const matching = records.filter((r) => safeString(r.orgId) === orgId);
  if (!matching.length) return;

  for (let i = 0; i < matching.length; i += BATCH_SIZE) {
    const batch = matching.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((record) => {
      const { _id, originalId, orgId: _o, archivedAt: _a, ...rest } = record;
      const docId = originalId || _id;
      return db.collection(targetCol).doc(docId).set({ data: rest });
    }));
  }

  for (let i = 0; i < matching.length; i += BATCH_SIZE) {
    const batch = matching.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((doc) =>
      db.collection(historyCol).doc(doc._id).remove()
    ));
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function doArchive(orgId) {
  const tasks = ARCHIVE_SPECS.map((spec) => () =>
    archiveCollection(spec.source, spec.history, orgId)
  );
  tasks.push(() => archiveAdmins(orgId));

  for (const group of chunkArray(tasks, CONCURRENCY)) {
    await Promise.all(group.map((t) => t()));
  }
}

async function doRestore(orgId) {
  const tasks = ARCHIVE_SPECS.map((spec) => () =>
    restoreCollection(spec.history, spec.source, orgId)
  );
  tasks.push(() => restoreCollection('admin_info_history', 'admin_info', orgId));

  for (const group of chunkArray(tasks, CONCURRENCY)) {
    await Promise.all(group.map((t) => t()));
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const operator = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active', adminLevel: 'root_admin' })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return { status: 'forbidden', message: '仅至高权限管理员可切换组织' };
  }

  const mode = event.mode || 'full';

  // ── 仅归档 ──
  if (mode === 'archive') {
    const configRes = await db.collection('system_config').doc(CONFIG_ID).get().catch(() => ({ data: null }));
    const currentOrgId = (configRes.data && configRes.data.currentOrganization) || null;
    if (!currentOrgId) {
      return { status: 'success', message: '无当前组织，无需归档' };
    }
    await doArchive(currentOrgId);
    return { status: 'success', message: '归档完成' };
  }

  // ── 仅恢复 ──
  if (mode === 'restore') {
    const targetOrgId = safeString(event.organizationId);
    const targetOrgName = safeString(event.organizationName);
    if (!targetOrgId || !targetOrgName) {
      return { status: 'invalid_params', message: '请提供组织ID和名称' };
    }

    await doRestore(targetOrgId);

    const existingOrg = await db.collection('organizations').doc(targetOrgId).get().catch(() => ({ data: null }));
    if (existingOrg && existingOrg.data) {
      await db.collection('organizations').doc(targetOrgId).update({
        data: { name: targetOrgName }
      });
    } else {
      await db.collection('organizations').add({
        data: {
          _id: targetOrgId,
          name: targetOrgName,
          createdAt: db.serverDate()
        }
      });
    }

    const configRes = await db.collection('system_config').doc(CONFIG_ID).get().catch(() => ({ data: null }));
    if (configRes.data) {
      await db.collection('system_config').doc(CONFIG_ID).update({
        data: {
          currentOrganization: targetOrgId,
          updatedAt: db.serverDate()
        }
      });
    } else {
      await db.collection('system_config').add({
        data: {
          _id: CONFIG_ID,
          timezone: 8,
          currentOrganization: targetOrgId,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }

    const isHistoricalOrg = !!(existingOrg && existingOrg.data);
    return {
      status: 'success',
      message: isHistoricalOrg
        ? `已切换至历史组织「${targetOrgName}」，数据已恢复`
        : `已切换至新组织「${targetOrgName}」`
    };
  }

  // ── 完整流程 (mode === 'full'，向后兼容) ──
  const targetOrgId = safeString(event.organizationId);
  const targetOrgName = safeString(event.organizationName);
  if (!targetOrgId || !targetOrgName) {
    return { status: 'invalid_params', message: '请提供组织ID和名称' };
  }

  const configRes = await db.collection('system_config').doc(CONFIG_ID).get().catch(() => ({ data: null }));
  const currentOrgId = (configRes.data && configRes.data.currentOrganization) || null;

  if (currentOrgId === targetOrgId) {
    return { status: 'success', message: '已是当前组织，无需切换' };
  }

  const hasCurrentOrg = !!currentOrgId;

  if (hasCurrentOrg) {
    await doArchive(currentOrgId);
  }

  await doRestore(targetOrgId);

  const existingOrg = await db.collection('organizations').doc(targetOrgId).get().catch(() => ({ data: null }));
  if (hasCurrentOrg && existingOrg && existingOrg.data) {
    await db.collection('organizations').doc(targetOrgId).update({
      data: { name: targetOrgName }
    });
  } else if (!existingOrg || !existingOrg.data) {
    await db.collection('organizations').add({
      data: {
        _id: targetOrgId,
        name: targetOrgName,
        createdAt: db.serverDate()
      }
    });
  } else {
    await db.collection('organizations').doc(targetOrgId).update({
      data: { name: targetOrgName }
    });
  }

  if (configRes.data) {
    await db.collection('system_config').doc(CONFIG_ID).update({
      data: {
        currentOrganization: targetOrgId,
        updatedAt: db.serverDate()
      }
    });
  } else {
    await db.collection('system_config').add({
      data: {
        _id: CONFIG_ID,
        timezone: 8,
        currentOrganization: targetOrgId,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }

  const isHistoricalOrg = !!(existingOrg && existingOrg.data);
  return {
    status: 'success',
    message: isHistoricalOrg
      ? `已切换至历史组织「${targetOrgName}」，数据已恢复`
      : `已切换至新组织「${targetOrgName}」`
  };
};
