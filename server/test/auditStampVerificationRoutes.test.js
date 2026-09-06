'use strict';

const assert = require('assert');
const Module = require('module');

let stampUpdateResult = false;
let stampRemoveResult = false;
let assignmentResult = { status: 'success' };
let verificationCreateResult = { status: 'success' };
let verificationRemoveResult = true;

const emptyModel = {};
const mocks = {
  '../../../utils/helpers': {
    safeString(value) { return value == null ? '' : String(value).trim(); },
    generateId() { return 'generated-id'; }
  },
  '../../../utils/orgContext': { async getCurrentOrgId() { return 'org-current'; } },
  '../../../config/db': {},
  '../../../core/models/adminInfo': { async getByOpenid() { return { id: 'admin-current' }; } },
  '../../../core/models/hrInfo': {
    async getByIds() { throw new Error('验签授权名单不得再跨表二次读取人员'); }
  },
  '../models/auditFlowTemplate': emptyModel,
  '../models/auditFlowTemplateStep': emptyModel,
  '../models/auditFlowTemplateStepCondition': emptyModel,
  '../models/stamp': {
    async update() { return stampUpdateResult; },
    async remove() { return stampRemoveResult; },
    async create() {},
    async getAll() { return []; }
  },
  '../models/identityStampAssignment': {
    async replaceForIdentity() { return assignmentResult; },
    async getAllGrouped() { return []; }
  },
  '../models/auditSubmission': emptyModel,
  '../models/auditSubmissionStep': emptyModel,
  '../models/auditSubmissionFile': emptyModel,
  '../models/auditSubmissionSignature': emptyModel,
  '../models/auditEvent': emptyModel,
  '../models/verificationPermission': {
    async getAll() {
      return [{
        id: 'permission-current',
        grantee_hr_id: 'hr-current',
        grantee_name: '当前组织成员',
        granted_by: 'admin-current',
        created_at: '2026-08-30 10:00:00'
      }];
    },
    async create() { return verificationCreateResult; },
    async removeByGrantee() { return verificationRemoveResult; }
  },
  '../services/auditPersonAssignmentCondition': { async resolveAndValidateBindings() { return []; } },
  '../../../core/services/dictionaryUsage': emptyModel
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const router = require('../src/modules/audit/routes/auditAdmin');
Module._load = originalLoad;

function findRoute(routePath) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert(layer, '缺少路由：' + routePath);
  return layer.route.stack[0].handle;
}

async function invoke(routePath, body) {
  let payload = null;
  await findRoute(routePath)({
    body: body || {},
    admin: { id: 'admin-current' }
  }, {
    json(value) {
      payload = value;
      return value;
    }
  });
  return payload;
}

(async () => {
  const validPngData = 'data:image/png;base64,'
    + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  let response = await invoke('/saveStamp', {
    id: 'stamp-foreign',
    name: '其他组织印章',
    imageData: validPngData
  });
  assert.strictEqual(response.status, 'not_found', '跨组织印章不得伪装成更新成功');

  response = await invoke('/deleteStamp', { id: 'stamp-foreign' });
  assert.strictEqual(response.status, 'not_found', '跨组织印章不得伪装成删除成功');

  assignmentResult = { status: 'identity_not_found' };
  response = await invoke('/saveStampAssignments', {
    identityId: 'identity-foreign',
    stampIds: ['stamp-current']
  });
  assert.strictEqual(response.status, 'not_found', '跨组织身份类别不得获得印章授权');

  assignmentResult = { status: 'stamp_not_found' };
  response = await invoke('/saveStampAssignments', {
    identityId: 'identity-current',
    stampIds: ['stamp-foreign']
  });
  assert.strictEqual(response.status, 'not_found', '跨组织印章不得进入当前组织授权');

  verificationCreateResult = { status: 'grantee_not_found' };
  response = await invoke('/saveVerificationPermission', {
    granteeHrId: 'hr-foreign',
    action: 'grant'
  });
  assert.strictEqual(response.status, 'not_found', '跨组织人员不得获得验签权限');

  verificationCreateResult = { status: 'duplicate' };
  response = await invoke('/saveVerificationPermission', {
    granteeHrId: 'hr-current',
    action: 'grant'
  });
  assert.strictEqual(response.status, 'duplicate');

  verificationRemoveResult = false;
  response = await invoke('/saveVerificationPermission', {
    granteeHrId: 'hr-foreign',
    action: 'revoke'
  });
  assert.strictEqual(response.status, 'not_found', '撤销其他组织人员时不得伪装成成功');

  response = await invoke('/listVerificationPermissions', {});
  assert.strictEqual(response.status, 'success');
  assert.strictEqual(response.permissions[0].granteeName, '当前组织成员');

  console.log('审核印章与验签管理路由目标组织校验测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
