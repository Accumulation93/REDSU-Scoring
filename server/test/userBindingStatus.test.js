'use strict';
const assert = require('assert');
const { resolveHrBindingStates } = require('../src/core/services/userBindingStatus');

const calls = [];
const model = {
  async listWechatBindingStatesByHrIds(ids, orgId) {
    calls.push({ ids, orgId });
    return ids.map((id) => ({
      hr_id: id, account_id: 'account-' + id, has_active_binding: id === 'bound' ? 1 : 0
    })).concat([{ hr_id: 'outside-scope', has_active_binding: 1 }]);
  }
};
async function run() {
  const states = await resolveHrBindingStates([
    { id: 'bound', name: '同名', student_id: 'corrected' },
    { id: 'unbound', name: '同名', student_id: 'corrected' },
    { id: 'unbound', name: '旧姓名' }, { id: '' }
  ], 'org-one', model);
  assert.strictEqual(states.size, 2);
  assert.deepStrictEqual(states.get('bound'), { status: 'bound', userInfoId: '', boundOpenid: '' });
  assert.strictEqual(states.get('unbound').status, 'unbound');
  assert.deepStrictEqual(calls, [{ ids: ['bound', 'unbound'], orgId: 'org-one' }]);
  calls.length = 0;
  await resolveHrBindingStates(Array.from({ length: 1001 }, (_, i) => ({ id: 'hr-' + i })), 'org-one', model);
  assert.deepStrictEqual(calls.map((call) => call.ids.length), [500, 500, 1]);
  calls.length = 0;
  assert.strictEqual((await resolveHrBindingStates([{ id: 'bound' }], '', model)).size, 0);
  assert.strictEqual(calls.length, 0);
  console.log('自然人微信凭据状态、同名隔离与批量查询测试通过');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
