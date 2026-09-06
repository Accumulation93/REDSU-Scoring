const { safeString } = require('../../utils/helpers');

const QUERY_CHUNK_SIZE = 500;

async function resolveHrBindingStates(rows, orgId, model) {
  const bindingModel = model || require('../models/personIdentityOverview');
  const ids = [...new Set((rows || []).map((row) => safeString(row.id)).filter(Boolean))];
  const states = new Map();
  if (!ids.length || !orgId) return states;
  ids.forEach((id) => states.set(id, { status: 'unbound', userInfoId: '', boundOpenid: '' }));
  for (let index = 0; index < ids.length; index += QUERY_CHUNK_SIZE) {
    const bindings = await bindingModel.listWechatBindingStatesByHrIds(ids.slice(index, index + QUERY_CHUNK_SIZE), orgId);
    bindings.forEach((binding) => {
      const id = safeString(binding.hr_id);
      if (!states.has(id)) return;
      // 兼容响应保留空旧字段；学号纠错、跨组织同名或旧微信映射都不参与判定。
      states.set(id, { status: Number(binding.has_active_binding) ? 'bound' : 'unbound', userInfoId: '', boundOpenid: '' });
    });
  }
  return states;
}

module.exports = { resolveHrBindingStates };
