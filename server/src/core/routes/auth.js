const localeCopy = require('../../locales/zh-CN/generated/core/routes/auth');
const retiredCopy = require('../../locales/zh-CN/generated/core/routes/admin');
const express = require('express');
const router = express.Router();
const { safeString } = require('../../utils/helpers');
const systemConfigModel = require('../models/systemConfig');
const { getAuthenticatedContext } = require('../services/authenticatedContext');
const { listAvailableOrganizations } = require('../services/accessibleOrganizations');

// 旧登录和组织激活协议无法原子更新统一会话，不再提供微信查人或自动建绑定的旁路。
function requireUnifiedClient(req, res) {
  return res.status(426).json({
    status: 'client_upgrade_required',
    message: localeCopy.copy_bfb0d21b30
  });
}
router.post('/userLogin', requireUnifiedClient);
router.post('/adminLogin', requireUnifiedClient);
router.post('/activateOrganization', requireUnifiedClient);

async function listOrganizationsForRole(req, res, role) {
  try {
    if (!getAuthenticatedContext(req)) {
      return res.json({ status: 'auth_failed', message: localeCopy.copy_c22a252e97 });
    }
    const organizations = await listAvailableOrganizations(req, role);
    if (role === 'admin') {
      const config = await systemConfigModel.get();
      const preferred = safeString(config && config.current_organization);
      if (preferred) organizations.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    }
    return res.json({ status: 'success', organizations });
  } catch (error) {
    return res.json({ status: 'error', message: safeString(error.message) });
  }
}

// 保留目录响应契约，组织范围只来自当前账号的有效成员关系或管理授权。
router.post('/listMyOrganizations', (req, res) => listOrganizationsForRole(req, res, 'user'));
router.post('/admin/listMyOrganizations', (req, res) => listOrganizationsForRole(req, res, 'admin'));

router.post('/confirmAutoBind', (req, res) => res.status(410).json({
  status: 'legacy_api_retired',
  message: retiredCopy.copy_0429e2ed3a
}));

router.post('/bindUserInfo', requireUnifiedClient);
router.post('/bindAdminInfo', (req, res) => res.status(426).json({
  status: 'client_upgrade_required',
  message: localeCopy.copy_58b32c9011
}));

// 解绑必须经过统一账号的恢复与会话撤销流程。
router.post('/unbindRole', (req, res) => res.status(410).json({
  status: 'recovery_required',
  message: localeCopy.copy_7d3da3e6c7
}));

module.exports = router;
