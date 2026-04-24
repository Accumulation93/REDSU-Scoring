const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeQuestion(item = {}) {
  return {
    question: item.question || '',
    scoreLabel: item.scoreLabel || '',
    minValue: toNumber(item.minValue, 0),
    startValue: toNumber(item.startValue, 0),
    maxValue: toNumber(item.maxValue, 0),
    stepValue: toNumber(item.stepValue, 0.5)
  };
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const operator = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return {
      status: 'forbidden',
      message: '没有管理权限'
    };
  }

  const res = await db.collection('score_question_templates')
    .limit(1000)
    .get();

  const list = res.data.map((item) => ({
    id: item._id,
    name: item.name || '',
    description: item.description || '',
    questions: (item.questions || []).map((question) => normalizeQuestion(question)),
    questionCount: (item.questions || []).length,
    sortOrder: Number(item.sortOrder) || 999999
  })).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });

  return {
    status: 'success',
    list
  };
};
