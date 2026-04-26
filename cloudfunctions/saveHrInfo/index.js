const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CACHE_META_COLLECTIONS = ['score_results_cache_meta', 'scorer_task_cache_meta'];

async function invalidateAllScoreCaches() {
  for (const collectionName of CACHE_META_COLLECTIONS) {
    while (true) {
      const res = await db.collection(collectionName)
        .where({ isInvalid: false })
        .limit(100)
        .get()
        .catch(() => ({ data: [] }));
      const rows = res.data || [];
      if (!rows.length) {
        break;
      }
      await Promise.all(rows.map((item) => (
        db.collection(collectionName).doc(item._id).update({
          data: {
            isInvalid: true,
            invalidatedAt: db.serverDate()
          }
        }).catch(() => null)
      )));
      if (rows.length < 100) {
        break;
      }
    }
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();
  const name = String(event.name || '').trim();
  const studentId = String(event.studentId || '').trim();
  const department = String(event.department || '').trim();
  const identity = String(event.identity || '').trim();
  const workGroup = String(event.workGroup || '').trim();

  const operator = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return {
      status: 'forbidden'
    };
  }

  if (!name || !studentId || !department || !identity) {
    return {
      status: 'invalid_params',
      message: '姓名、学号、所属部门和身份为必填项'
    };
  }

  // 验证部门是否存在
  const departmentExists = await db.collection('departments')
    .where({ name: department })
    .limit(1)
    .get();
  if (!departmentExists.data.length) {
    return {
      status: 'invalid_params',
      message: '部门不存在，请先在部门维护中添加'
    };
  }

  // 验证身份是否存在
  const identityExists = await db.collection('identities')
    .where({ name: identity })
    .limit(1)
    .get();
  if (!identityExists.data.length) {
    return {
      status: 'invalid_params',
      message: '身份不存在，请先在身份类别维护中添加'
    };
  }

  // 验证工作分工是否存在（如果填写了）
  if (workGroup) {
    const departmentId = departmentExists.data[0]._id;
    const workGroupExists = await db.collection('work_groups')
      .where({ departmentId, name: workGroup })
      .limit(1)
      .get();
    if (!workGroupExists.data.length) {
      return {
        status: 'invalid_params',
        message: '工作分工不存在，请先在工作分工维护中添加'
      };
    }
  }

  const payload = {
    姓名: name,
    学号: studentId,
    所属部门: department,
    身份: identity,
    '工作分工（职能组）': workGroup,
    name,
    studentId,
    department,
    identity,
    workGroup
  };

  if (id) {
    await db.collection('hr_info')
      .doc(id)
      .update({
        data: payload
      });
  } else {
    const existing = await db.collection('hr_info')
      .where({
        学号: studentId
      })
      .limit(1)
      .get();

    if (existing.data.length) {
      await db.collection('hr_info')
        .doc(existing.data[0]._id)
        .update({
          data: payload
        });
    } else {
      await db.collection('hr_info').add({
        data: payload
      });
    }
  }

  await invalidateAllScoreCaches();

  return {
    status: 'success'
  };
};
