const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

const HISTORY_COLLECTIONS = [
  'hr_info_history',
  'admin_info_history',
  'departments_history',
  'hr_profile_records_history',
  'hr_profile_templates_history',
  'identities_history',
  'rate_target_rules_history',
  'score_activities_history',
  'score_records_history',
  'user_info_history',
  'work_groups_history'
];

async function removeAllFromCollection(collectionName, orgId) {
  const PAGE_SIZE = 100;
  while (true) {
    const res = await db.collection(collectionName)
      .where({ orgId })
      .limit(PAGE_SIZE)
      .get();

    const batch = res.data || [];
    if (!batch.length) break;

    await Promise.all(batch.map((doc) =>
      db.collection(collectionName).doc(doc._id).remove()
    ));
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
    return { status: 'forbidden', message: '仅至高权限管理员可操作' };
  }

  const organizationId = safeString(event.organizationId);
  if (!organizationId) {
    return { status: 'invalid_params', message: '请指定要删除的组织' };
  }

  const configRes = await db.collection('system_config').doc('default').get().catch(() => ({ data: null }));
  const currentOrgId = (configRes.data && configRes.data.currentOrganization) || null;
  if (currentOrgId === organizationId) {
    return { status: 'invalid_operation', message: '不能删除当前正在使用的组织，请先切换到其他组织' };
  }

  for (const col of HISTORY_COLLECTIONS) {
    await removeAllFromCollection(col, organizationId);
  }

  await db.collection('organizations').doc(organizationId).remove();

  return { status: 'success' };
};
