const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const CONFIG_ID = 'default';

exports.main = async () => {
  const res = await db.collection('system_config').doc(CONFIG_ID).get().catch(() => ({ data: null }));
  const doc = res.data || {};
  return {
    status: 'success',
    config: {
      timezone: Number(doc.timezone) || 8,
      currentOrganization: doc.currentOrganization || null
    }
  };
};
