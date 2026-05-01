const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PAGE_SIZE = 100;

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

async function getAllRecords(query) {
  const list = [];
  let skip = 0;
  while (true) {
    const res = await query.where({}).skip(skip).limit(PAGE_SIZE).get();
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
    skip += batch.length;
  }
  return list;
}

async function runLimited(items = [], limit = 12, handler) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await handler(item);
    }
  });
  await Promise.all(workers);
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

function buildQuestionStructureSignature(questions = []) {
  return (questions || [])
    .map((item) => [Number(item.minValue), Number(item.startValue), Number(item.maxValue), Number(item.stepValue)].join(':'))
    .join('|');
}

function buildTemplateConfigSignature(questions = []) {
  return (questions || [])
    .map((item, index) => [index, item.question || '', item.scoreLabel || '', Number(item.minValue), Number(item.startValue), Number(item.maxValue), Number(item.stepValue)].join(':'))
    .join('|');
}

function isTemplateUsedInRecord(record = {}, templateId = '') {
  const id = String(templateId || '').trim();
  if (!id) {
    return false;
  }
  return (Array.isArray(record.templateScores) && record.templateScores.some((item) => String(item.templateId || '') === id))
    || (Array.isArray(record.answers) && record.answers.some((item) => String(item.templateId || '') === id))
    || (Array.isArray(record.templateConfigs) && record.templateConfigs.some((item) => String(item.templateId || '') === id));
}

async function removeScoreRecordsForTemplate(templateId = '') {
  const records = await getAllRecords(db.collection('score_records'));
  const matchedRecords = records.filter((record) => isTemplateUsedInRecord(record, templateId));
  await runLimited(matchedRecords, 12, (record) => db.collection('score_records').doc(record._id).remove().catch(() => null));
  return matchedRecords.length;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();
  const name = String(event.name || '').trim();
  const description = String(event.description || '').trim();
  const questions = Array.isArray(event.questions) ? event.questions : [];

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
    configSignature: buildTemplateConfigSignature(validQuestions),
    updatedAt: db.serverDate(),
    updatedBy: operator.data[0]._id
  };

  let targetTemplateId = id;
  let removedRecordCount = 0;
  let oldStructureSignature = '';
  const currentTemplateRes = id
    ? await db.collection('score_question_templates').doc(id).get().catch(() => ({ data: null }))
    : { data: null };
  if (currentTemplateRes.data) {
    oldStructureSignature = buildQuestionStructureSignature(currentTemplateRes.data.questions || []);
  }
  const newStructureSignature = buildQuestionStructureSignature(validQuestions);

  if (id) {
    await db.collection('score_question_templates')
      .doc(id)
      .update({
        data: { ...payload, sortOrder: db.command.remove() }
      });
  } else {
    const existing = await db.collection('score_question_templates')
      .where({
        name
      })
      .limit(1)
      .get();

    if (existing.data.length) {
      targetTemplateId = existing.data[0]._id;
      oldStructureSignature = buildQuestionStructureSignature(existing.data[0].questions || []);
      await db.collection('score_question_templates')
        .doc(existing.data[0]._id)
        .update({
          data: { ...payload, sortOrder: db.command.remove() }
        });
    } else {
      const addRes = await db.collection('score_question_templates').add({
        data: {
          ...payload,
          createdAt: db.serverDate(),
          createdBy: operator.data[0]._id
        }
      });
      targetTemplateId = addRes._id;
    }
  }

  if (targetTemplateId && oldStructureSignature && oldStructureSignature !== newStructureSignature) {
    removedRecordCount = await removeScoreRecordsForTemplate(targetTemplateId);
  }

  return {
    status: 'success',
    removedRecordCount
  };
};
