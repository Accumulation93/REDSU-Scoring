'use strict';

const localeCopy = require('../../../locales/zh-CN/generated/subpackages/venue/utils/venueRuleDisplay');
const BOOKING_RULE_LABELS = {
  admin: localeCopy.copy_af20193574,
  direct: localeCopy.copy_4f15bb9939,
  flow: localeCopy.copy_c5b4f4062e
};

function buildBookingRuleDisplayList(rules) {
  return (Array.isArray(rules) ? rules : []).map((rule) => ({
    ...rule,
    _ruleTypeLabel: BOOKING_RULE_LABELS[rule.rule_type] || rule.rule_type || localeCopy.copy_af20193574
  }));
}

module.exports = { buildBookingRuleDisplayList };
