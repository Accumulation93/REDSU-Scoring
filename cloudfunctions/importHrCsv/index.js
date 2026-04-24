const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function parseCsv(content) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;
  const text = String(content || '').replace(/^\uFEFF/, '');

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
      if (char === '\r' && next === '\n') {
        i += 1;
      }
      row.push(current);
      if (row.some((item) => String(item).trim())) {
        rows.push(row);
      }
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  if (current || row.length) {
    row.push(current);
    if (row.some((item) => String(item).trim())) {
      rows.push(row);
    }
  }

  return rows;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const csvContent = String(event.csvContent || '');

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

  const rows = parseCsv(csvContent);
  if (rows.length < 2) {
    return {
      status: 'invalid_params',
      message: 'CSV 至少需要表头和一行数据'
    };
  }

  const headers = rows[0].map((item) => String(item).trim());
  let count = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const doc = {};

    headers.forEach((header, index) => {
      doc[header] = String(row[index] || '').trim();
    });

    if (!doc['学号']) {
      continue;
    }

    doc.name = doc['姓名'] || '';
    doc.studentId = doc['学号'] || '';
    doc.department = doc['所属部门'] || '';
    doc.identity = doc['身份'] || '';
    doc.workGroup = doc['工作分工（职能组）'] || '';

    const existing = await db.collection('hr_info')
      .where({
        学号: doc['学号']
      })
      .limit(1)
      .get();

    if (existing.data.length) {
      await db.collection('hr_info')
        .doc(existing.data[0]._id)
        .update({
          data: doc
        });
    } else {
      await db.collection('hr_info').add({
        data: doc
      });
    }

    count += 1;
  }

  return {
    status: 'success',
    count
  };
};
