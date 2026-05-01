const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PAGE_SIZE = 100;

const DEFAULT_COLLECTIONS = [
  'admin_info',
  'departments',
  'hr_info',
  'hr_profile_records',
  'hr_profile_templates',
  'identities',
  'rate_target_rules',
  'score_activities',
  'score_question_templates',
  'score_records',
  'user_info',
  'work_groups'
];

const HEADER_LABELS = ['集合名称', '字段路径', '主类型', '所有类型', '覆盖率', '涉及文档数', '示例值'];

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

function getType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value.toDate === 'function') return 'date';
  if (value instanceof Object && value.constructor === Object) return 'object';
  return typeof value;
}

function sampleValue(value) {
  if (value === null || value === undefined) return '';
  const type = getType(value);
  if (type === 'date') return value.toDate().toISOString();
  if (type === 'array') {
    if (value.length === 0) return '[]';
    const first = sampleValue(value[0]);
    return `[${first}${value.length > 1 ? ', ...' : ''}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''}}`;
  }
  const s = String(value);
  return s.length > 80 ? s.substring(0, 80) + '...' : s;
}

function walkFields(value, prefix, fields) {
  const type = getType(value);
  if (!fields[prefix]) {
    fields[prefix] = { path: prefix, types: {}, docCount: 0, samples: [] };
  }
  fields[prefix].types[type] = (fields[prefix].types[type] || 0) + 1;
  fields[prefix].docCount += 1;
  if (fields[prefix].samples.length < 3) {
    const sv = sampleValue(value);
    if (sv !== '' || fields[prefix].samples.length === 0) {
      fields[prefix].samples.push(sv);
    }
  }

  if (type === 'object') {
    Object.keys(value || {}).forEach((key) => walkFields(value[key], `${prefix}.${key}`, fields));
  } else if (type === 'array' && value.length > 0) {
    value.slice(0, 10).forEach((item) => walkFields(item, `${prefix}[]`, fields));
  }
}

async function fetchCollectionSample(collectionName, limit) {
  const list = [];
  let skip = 0;
  while (list.length < limit) {
    const res = await db.collection(collectionName)
      .skip(skip)
      .limit(Math.min(PAGE_SIZE, limit - list.length))
      .get()
      .catch((error) => {
        const msg = safeString(error && (error.message || error.errMsg));
        if (msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists')) {
          return { data: [] };
        }
        throw error;
      });
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }
  return list;
}

function buildSchema(collectionName, rows) {
  const fields = {};
  rows.forEach((row) => {
    Object.keys(row || {}).forEach((key) => walkFields(row[key], key, fields));
  });
  return {
    collectionName,
    sampledCount: rows.length,
    fields: Object.values(fields).sort((a, b) => a.path.localeCompare(b.path))
  };
}

function summarizeField(field, totalDocs) {
  const types = Object.entries(field.types).sort((a, b) => b[1] - a[1]);
  const primaryType = types[0] ? types[0][0] : 'unknown';
  const nullCount = field.types['null'] || 0;
  const coverage = totalDocs > 0 ? Math.round(((totalDocs - nullCount) / totalDocs) * 100) : 0;
  const nonNullTypes = types.filter((t) => t[0] !== 'null');
  const observedTypes = nonNullTypes.map((t) => t[0]).join('|') || '-';
  const samples = field.samples.filter((s) => s !== '').slice(0, 2).join(' ; ');
  return {
    path: field.path,
    primaryType,
    observedTypes,
    coverage: coverage + '%',
    docCount: field.docCount,
    samples
  };
}

// --- CSV ---
function escapeCsv(value) {
  const text = String(value == null ? '' : value);
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(schemas) {
  const header = HEADER_LABELS;
  const lines = [header.join(',')];
  schemas.forEach((schema) => {
    if (schema.fields.length === 0) {
      lines.push([schema.collectionName, '(空集合，无文档)', '', '', '', '', ''].join(','));
      return;
    }
    schema.fields.forEach((field) => {
      const f = summarizeField(field, schema.sampledCount);
      lines.push([
        escapeCsv(schema.collectionName),
        escapeCsv(f.path),
        escapeCsv(f.primaryType),
        escapeCsv(f.observedTypes),
        escapeCsv(f.coverage),
        escapeCsv(f.docCount),
        escapeCsv(f.samples)
      ].join(','));
    });
  });
  return '﻿' + lines.join('\r\n');
}

// --- Excel XML ---
function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '');
}

function buildExcelXml(schemas) {
  const headers = HEADER_LABELS;
  let rows = '';
  schemas.forEach((schema) => {
    if (schema.fields.length === 0) {
      rows += `<Row><Cell><Data ss:Type="String">${escapeXml(schema.collectionName)}</Data></Cell>`
        + '<Cell><Data ss:Type="String">(空集合，无文档)</Data></Cell>'
        + '<Cell></Cell><Cell></Cell><Cell></Cell><Cell></Cell><Cell></Cell></Row>';
      return;
    }
    schema.fields.forEach((field) => {
      const f = summarizeField(field, schema.sampledCount);
      rows += `<Row>`
        + `<Cell><Data ss:Type="String">${escapeXml(schema.collectionName)}</Data></Cell>`
        + `<Cell><Data ss:Type="String">${escapeXml(f.path)}</Data></Cell>`
        + `<Cell><Data ss:Type="String">${escapeXml(f.primaryType)}</Data></Cell>`
        + `<Cell><Data ss:Type="String">${escapeXml(f.observedTypes)}</Data></Cell>`
        + `<Cell><Data ss:Type="String">${escapeXml(f.coverage)}</Data></Cell>`
        + `<Cell><Data ss:Type="Number">${f.docCount}</Data></Cell>`
        + `<Cell><Data ss:Type="String">${escapeXml(f.samples)}</Data></Cell>`
        + `</Row>`;
    });
  });

  const headerRow = headers.map((h) =>
    `<Cell><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`
  ).join('');

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<?mso-application progid="Excel.Sheet"?>`,
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"`,
    ` xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`,
    `<Styles>`,
    `<Style ss:ID="Header">`,
    `<Font ss:Bold="1"/><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/>`,
    `</Style>`,
    `</Styles>`,
    `<Worksheet ss:Name="数据库结构">`,
    `<Table>`,
    `<Row ss:StyleID="Header">${headerRow}</Row>`,
    rows,
    `</Table>`,
    `</Worksheet>`,
    `</Workbook>`
  ].join('\r\n');
}

// --- 表格化终端输出 ---
function printTerminalTable(summary) {
  const rows = [];
  summary.forEach((schema) => {
    rows.push([
      schema.collectionName,
      String(schema.sampledCount),
      String(schema.fieldCount)
    ]);
  });

  const header = ['集合名称', '采样文档数', '字段数'];
  const colWidths = [
    Math.max(...rows.map((r) => r[0].length), header[0].length),
    Math.max(...rows.map((r) => r[1].length), header[1].length),
    Math.max(...rows.map((r) => r[2].length), header[2].length)
  ];

  const pad = (s, w) => {
    const gap = w - String(s).length;
    return String(s) + ' '.repeat(gap > 0 ? gap : 0);
  };
  const sep = colWidths.map((w) => '-'.repeat(w)).join('-+-');
  const headerLine = colWidths.map((w, i) => pad(header[i], w)).join(' | ');

  console.log(headerLine);
  console.log(sep);
  rows.forEach((row) => {
    console.log(colWidths.map((w, i) => pad(row[i], w)).join(' | '));
  });

  // 展开每个集合的字段详情
  console.log('');
  summary.forEach((schema) => {
    console.log(`\n── ${schema.collectionName}  (${schema.fieldCount} 个字段, 采样 ${schema.sampledCount} 条) ──`);
    if (schema.fieldCount === 0) {
      console.log('  (空集合，无文档)');
      return;
    }
    const fieldWidths = [50, 10, 18, 8, 8];
    const fh = ['字段路径', '类型', '所有类型', '覆盖率', '文档数'];
    const fSep = fieldWidths.map((w) => '-'.repeat(w)).join('-+-');
    console.log('  ' + fieldWidths.map((w, i) => pad(fh[i], w)).join(' | '));
    console.log('  ' + fSep);
    schema.fields.forEach((field) => {
      const fRow = [
        field.path.length > 50 ? field.path.substring(0, 47) + '...' : field.path,
        field.primaryType,
        field.observedTypes,
        field.coverage,
        String(field.docCount)
      ];
      console.log('  ' + fieldWidths.map((w, i) => pad(fRow[i], w)).join(' | '));
      if (field.samples) {
        console.log('    -> 示例: ' + field.samples);
      }
    });
  });
}

// ============================================================
// 云函数入口
// ============================================================
exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '没有管理权限' };

  const collections = Array.isArray(event.collections) && event.collections.length
    ? event.collections.map((item) => safeString(item)).filter(Boolean)
    : DEFAULT_COLLECTIONS;
  const sampleLimit = Math.max(1, Math.min(Number(event.limit) || 200, 1000));
  const format = (event.format || 'json').toLowerCase();

  const schemas = [];
  for (const collectionName of collections) {
    console.log(`[exportDatabaseSchema] 正在扫描: ${collectionName} ...`);
    const rows = await fetchCollectionSample(collectionName, sampleLimit);
    schemas.push(buildSchema(collectionName, rows));
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

  if (format === 'csv') {
    const fileContent = buildCsv(schemas);
    console.log(fileContent);
    return {
      status: 'success',
      fileName: `database_schema_${timestamp}.csv`,
      extension: 'csv',
      fileContent
    };
  }

  if (format === 'excel' || format === 'xls') {
    const fileContent = buildExcelXml(schemas);
    console.log(fileContent);
    return {
      status: 'success',
      fileName: `database_schema_${timestamp}.xls`,
      extension: 'xls',
      fileContent
    };
  }

  const summary = schemas.map((schema) => {
    const totalDocs = schema.sampledCount;
    return {
      collectionName: schema.collectionName,
      sampledCount: totalDocs,
      fieldCount: schema.fields.length,
      fields: schema.fields.map((field) => summarizeField(field, totalDocs))
    };
  });

  // 终端友好输出
  printTerminalTable(summary);

  return {
    status: 'success',
    sampledLimit: sampleLimit,
    generatedAt: new Date().toISOString(),
    summary: {
      totalCollections: summary.length,
      totalFields: summary.reduce((sum, s) => sum + s.fieldCount, 0)
    },
    schemas: summary
  };
};

// ============================================================
// 命令行直接运行:  node index.js [format] [limit]
// 示例:
//   node index.js              # JSON 格式，终端表格输出
//   node index.js csv          # CSV 格式，直接打印
//   node index.js json 500     # JSON 格式，每表采样 500 条
// ============================================================
if (require.main === module) {
  const format = process.argv[2] || 'json';
  const limit = parseInt(process.argv[3]) || 200;
  const collections = process.argv.slice(4).length > 0
    ? process.argv.slice(4).filter((s) => s.length > 0)
    : undefined;

  console.log('═══════════════════════════════════════════');
  console.log('  exportDatabaseSchema - 本地终端模式');
  console.log(`  格式: ${format}  采样上限: ${limit}  指定集合: ${collections ? collections.join(', ') : '(全部)'}`);
  console.log('═══════════════════════════════════════════\n');

  // 本地运行时跳过鉴权，直接用空 openid (非云函数环境无 WXContext)
  const mockEvent = { format, limit };
  if (collections) mockEvent.collections = collections;

  // 绕过鉴权：伪造一个 admin 返回
  const originalEnsureAdmin = ensureAdmin;
  const originalContext = cloud.getWXContext;

  // 用闭包替换鉴权——本地 terminal 执行跳过鉴权检查
  const originalMain = exports.main;
  const source = originalMain.toString();
  // 更干净的方式：直接调用内部逻辑
  // 重写 getWXContext 返回假 openid，然后 ensureAdmin 查不到就算了我们还需要绕过去
  // 简单做法：直接置空鉴权结果

  console.log('[本地模式] 跳过管理员鉴权，直接导出...\n');

  // 直接执行核心逻辑 (复制自主函数体，但跳过鉴权)
  (async () => {
    try {
      const cols = collections || DEFAULT_COLLECTIONS;
      const sampleLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));

      const schemas = [];
      for (const collectionName of cols) {
        console.log(`[${cols.indexOf(collectionName) + 1}/${cols.length}] 正在扫描: ${collectionName} ...`);
        const rows = await fetchCollectionSample(collectionName, sampleLimit);
        schemas.push(buildSchema(collectionName, rows));
      }

      console.log('');

      if (format === 'csv') {
        console.log(buildCsv(schemas));
        return;
      }

      if (format === 'excel' || format === 'xls') {
        console.log(buildExcelXml(schemas));
        return;
      }

      const summary = schemas.map((schema) => {
        const totalDocs = schema.sampledCount;
        return {
          collectionName: schema.collectionName,
          sampledCount: totalDocs,
          fieldCount: schema.fields.length,
          fields: schema.fields.map((field) => summarizeField(field, totalDocs))
        };
      });

      printTerminalTable(summary);

      console.log(`\n总计: ${summary.length} 个集合, ${summary.reduce((sum, s) => sum + s.fieldCount, 0)} 个字段`);
    } catch (err) {
      console.error('\n执行失败:', err.message || err);
      console.error('\n提示：');
      console.error('  1. 请先打开微信开发者工具，右键本云函数 → "开启云函数本地调试"');
      console.error('  2. 然后在开发者工具的终端中运行: node index.js');
      console.error('  3. 或在小程序中调用该云函数，在开发者工具调试器面板查看返回结果');
      process.exit(1);
    }
  })();
}
