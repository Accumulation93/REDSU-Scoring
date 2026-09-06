const assert = require('assert');
const Module = require('module');
let queryResults = [];
const queries = [];
const pool = {
  async query(sql, params) { queries.push({ sql, params }); return [queryResults.shift() || []]; },
  async withTransaction(callback) { return callback(this); }
};
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === '../../config/db') return pool;
  if (name === '../services/identityCrypto') return {
    hmac: value => 'hmac:' + value, legacyHmac: value => 'old-hmac:' + value,
    legacyHash: value => 'old-hash:' + value
  };
  return originalLoad.call(this, name, parent, isMain);
};
const model = require('../src/core/models/unifiedIdentity');
Module._load = originalLoad;
async function run() {
  assert.strictEqual(await model.canOfferWechatBinding('', 'wx'), false);
  assert.strictEqual(await model.canOfferWechatBinding('account', ''), false);
  assert.strictEqual(queries.length, 0);
  queryResults = [[]];
  assert.strictEqual(await model.canOfferWechatBinding('account', 'wx'), false);
  assert.strictEqual(queries.length, 1, '目标已绑定或不可用时立即停止');
  queryResults = [[{ id: 'account' }], [{ occupied: 1 }]];
  assert.strictEqual(await model.canOfferWechatBinding('account', 'wx'), false);
  queryResults = [[{ id: 'account' }], []];
  assert.strictEqual(await model.canOfferWechatBinding('account', 'wx'), true);
  const occupation = queries[queries.length - 1];
  assert.deepStrictEqual(occupation.params, ['whusu-smart-workspace', 'hmac:wx', 'old-hmac:wx', 'old-hmac:wx', 'old-hash:wx', 'wx']);
  assert.doesNotMatch(occupation.sql, /JOIN accounts|JOIN persons/, '当前微信占用不能被所属账号状态过滤掉');
  assert(queries.every(item => /^\s*SELECT\b/.test(item.sql)), '资格检查只能读，不得迁移或创建绑定');
  queryResults = [[{ id: 'account', binding_id: 'existing' }], []];
  await assert.rejects(() => model.bindWechatAfterPassphraseLogin('account', 'wx', {}), error => error.code === 'wechat_conflict');
  console.log('微信绑定资格模型及目标被并发绑定的冲突保护测试通过');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
