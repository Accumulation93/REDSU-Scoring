const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async () => {
  const res = await db.collection('score_activities')
    .where({
      isCurrent: true
    })
    .limit(1)
    .get();

  if (!res.data.length) {
    return {
      status: 'success',
      activity: null
    };
  }

  const item = res.data[0];
  return {
    status: 'success',
    activity: {
      id: item._id,
      name: item.name || '',
      description: item.description || '',
      startDate: item.startDate || '',
      endDate: item.endDate || ''
    }
  };
};
