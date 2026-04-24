const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function normalizeQuestion(item = {}) {
  const question = String(item.question || '').trim();
  const scoreLabel = String(item.scoreLabel || '');
  const minValue = toNumber(item.minValue);
  const startValue = toNumber(item.startValue == null || item.startValue === '' ? 0 : item.startValue);
  const maxValue = toNumber(item.maxValue);
  const stepValue = toNumber(item.stepValue == null || item.stepValue === '' ? 0.5 : item.stepValue);

  return {
    question,
    scoreLabel,
    minValue,
    startValue,
    maxValue,
    stepValue
  };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();
  const name = String(event.name || '').trim();
  const description = String(event.description || '').trim();
  const questions = Array.isArray(event.questions) ? event.questions : [];
  const incomingSortOrder = Number(event.sortOrder);

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

  if (!name) {
    return {
      status: 'invalid_params',
      message: '模板名称不能为空'
    };
  }

  const normalizedQuestions = questions.map(normalizeQuestion).filter((item) => item.question);

  const validQuestions = normalizedQuestions.filter((item) => (
    item.question &&
    !Number.isNaN(item.minValue) &&
    !Number.isNaN(item.startValue) &&
    !Number.isNaN(item.maxValue) &&
    !Number.isNaN(item.stepValue) &&
    item.stepValue > 0 &&
    item.minValue <= item.maxValue &&
    item.startValue >= item.minValue &&
    item.startValue <= item.maxValue
  ));

  if (!validQuestions.length) {
    return {
      status: 'invalid_params',
      message: '请至少提供一个有效题目'
    };
  }

  const payload = {
    name,
    description,
    questions: validQuestions,
    updatedAt: db.serverDate(),
    updatedBy: operator.data[0]._id
  };

  if (id) {
    await db.collection('score_question_templates')
      .doc(id)
      .update({
        data: payload
      });
  } else {
    const existing = await db.collection('score_question_templates')
      .where({
        name
      })
      .limit(1)
      .get();

    if (existing.data.length) {
      await db.collection('score_question_templates')
        .doc(existing.data[0]._id)
        .update({
          data: payload
        });
    } else {
      let sortOrder = incomingSortOrder;
      if (!Number.isInteger(sortOrder) || sortOrder <= 0) {
        const countRes = await db.collection('score_question_templates').count();
        sortOrder = (countRes.total || 0) + 1;
      }

      await db.collection('score_question_templates').add({
        data: {
          ...payload,
          sortOrder,
          createdAt: db.serverDate(),
          createdBy: operator.data[0]._id
        }
      });
    }
  }

  return {
    status: 'success'
  };
};
