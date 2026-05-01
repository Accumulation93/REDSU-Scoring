const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function buildTemplateConfigSignature(questions = []) {
  return (questions || [])
    .map((item, index) => [index, item.question || '', item.scoreLabel || '', Number(item.minValue), Number(item.startValue), Number(item.maxValue), Number(item.stepValue)].join(':'))
    .join('|');
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();

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

  if (!id) {
    return {
      status: 'invalid_params',
      message: '缺少模板信息'
    };
  }

  const templateRes = await db.collection('score_question_templates').doc(id).get();
  const template = templateRes.data;

  if (!template) {
    return {
      status: 'not_found',
      message: '模板不存在'
    };
  }

  let name = `${template.name || '未命名模板'} 副本`;
  let counter = 2;
  while (true) {
    const exists = await db.collection('score_question_templates')
      .where({ name })
      .limit(1)
      .get();
    if (!exists.data.length) {
      break;
    }
    name = `${template.name || '未命名模板'} 副本${counter}`;
    counter += 1;
  }

  const addRes = await db.collection('score_question_templates').add({
    data: {
      name,
      description: template.description || '',
      questions: template.questions || [],
      configSignature: buildTemplateConfigSignature(template.questions || []),
      createdAt: db.serverDate(),
      createdBy: operator.data[0]._id,
      updatedAt: db.serverDate(),
      updatedBy: operator.data[0]._id
    }
  });

  return {
    status: 'success',
    id: addRes._id
  };
};
