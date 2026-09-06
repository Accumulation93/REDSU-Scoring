const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

function loadRoute(relativePath, dependencyMocks) {
  const routePath = path.resolve(__dirname, relativePath);
  const state = {
    fallbackAdmin: null,
    lookupCalls: 0
  };
  const mocks = Object.assign({
    '../../../core/models/adminInfo': {
      async getByOpenid(openid) {
        state.lookupCalls += 1;
        assert.strictEqual(openid, 'legacy-openid');
        return state.fallbackAdmin;
      }
    },
    '../../../config/db': {
      async query() { return [[]]; },
      async withTransaction(callback) { return callback({}); }
    },
    '../../../utils/orgContext': {
      async getCurrentOrgId() { return 'org-current'; }
    }
  }, dependencyMocks || {});

  delete require.cache[require.resolve(routePath)];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    if (request.endsWith('/config/db')) return mocks['../../../config/db'];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { router: require(routePath), state };
  } finally {
    Module._load = originalLoad;
  }
}

async function invoke(router, routePath, request) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert(layer, `缺少 ${routePath} 路由`);
  let payload;
  await layer.route.stack[0].handle(Object.assign({
    openid: 'legacy-openid',
    body: {},
    get() { return 'admin'; }
  }, request || {}), {
    json(value) {
      payload = value;
      return value;
    }
  });
  return payload;
}

async function verifyAdminResolution(testCase) {
  const loaded = loadRoute(testCase.file, testCase.mocks);
  const injectedAdmin = {
    id: 'grant-admin',
    admin_grant_id: 'grant-admin',
    admin_level: 'super_admin',
    org_id: ''
  };

  const injected = await invoke(loaded.router, testCase.route, {
    admin: injectedAdmin,
    body: testCase.body
  });
  assert.strictEqual(injected.status, testCase.authorizedStatus, `${testCase.route} 应接受 req.admin`);
  assert.strictEqual(loaded.state.lookupCalls, 0, `${testCase.route} 不得对 req.admin 二次查询 admin_info`);

  loaded.state.fallbackAdmin = { id: 'legacy-admin', admin_level: 'admin' };
  const explicitlyRejected = await invoke(loaded.router, testCase.route, {
    admin: null,
    body: testCase.body
  });
  assert.strictEqual(explicitlyRejected.status, 'forbidden', `${testCase.route} 应服从中间件注入的空管理员主体`);
  assert.strictEqual(loaded.state.lookupCalls, 0, `${testCase.route} 已有中间件字段时不得回退旧表`);

  const fallback = await invoke(loaded.router, testCase.route, { body: testCase.body });
  assert.strictEqual(fallback.status, 'forbidden', `${testCase.route} 只有微信标识不得获得管理权限`);
  assert.strictEqual(loaded.state.lookupCalls, 0, `${testCase.route} 禁止按微信补充认证`);

  loaded.state.fallbackAdmin = null;
  const forbidden = await invoke(loaded.router, testCase.route, { body: testCase.body });
  assert.strictEqual(forbidden.status, 'forbidden', `${testCase.route} 无管理员主体时必须显式拒绝`);
  assert.strictEqual(loaded.state.lookupCalls, 0, `${testCase.route} 拒绝路径不得查询旧微信表`);
  if (testCase.route === '/listScoreActivities') {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(forbidden, 'list'), false,
      '活动列表无权限时不得伪装为空列表');
  }

  return loaded;
}

async function run() {
  const routeFiles = [
    'activities.js', 'templates.js', 'rules.js', 'results.js', 'scoring.js', 'publications.js'
  ];
  routeFiles.forEach((fileName) => {
    const source = fs.readFileSync(path.resolve(
      __dirname, '../src/modules/scoring/routes', fileName
    ), 'utf8');
    assert.doesNotMatch(source, /ensureAdmin\((?:openid|req\.openid)\)/,
      `${fileName} 不得再以 OpenID 作为管理判定入口`);
    assert.strictEqual((source.match(/adminInfoModel\.getByOpenid\(/g) || []).length, 0,
      `${fileName} 禁止为了测试夹具保留旧 OpenID 回退`);
  });

  const emptyListModel = { async getAll() { return []; } };
  const scoringRouteMocks = {
    '../models/scoreActivity': {
      async getById() { return null; },
      async getCurrent() { return null; }
    },
    '../../../core/services/currentActor': {
      async resolveCurrentActor() {
        return { ok: true, actor: { type: 'user', contextId: 'context-user' } };
      }
    },
    '../services/participants': {
      normalizeGranularity() { return 'assignment'; },
      async resolveActorParticipant() { return null; },
      buildAssignmentLabel() { return ''; }
    },
    '../../../utils/orgContext': {
      async getCurrentOrgId() { return 'org-current'; }
    }
  };

  const cases = [
    {
      file: '../src/modules/scoring/routes/activities.js',
      route: '/listScoreActivities',
      body: {},
      authorizedStatus: 'success',
      mocks: {
        '../models/scoreActivity': emptyListModel
      }
    },
    {
      file: '../src/modules/scoring/routes/templates.js',
      route: '/listScoreTemplates',
      body: {},
      authorizedStatus: 'success',
      mocks: {
        '../models/scoreTemplate': emptyListModel,
        '../../../config/db': {
          async query() { return [[]]; }
        },
        '../../../utils/orgContext': {
          async getCurrentOrgId() { return 'org-current'; }
        }
      }
    },
    {
      file: '../src/modules/scoring/routes/rules.js',
      route: '/listRateRules',
      body: {},
      authorizedStatus: 'success',
      mocks: {
        '../models/rateRule': emptyListModel,
        '../../../core/models/department': emptyListModel,
        '../../../core/models/identity': emptyListModel,
        '../models/scoreTemplate': emptyListModel,
        '../models/scoreActivity': emptyListModel,
        '../../../config/db': {
          async withTransaction(callback) { return callback({}); }
        },
        '../../../utils/orgContext': {
          async getCurrentOrgId() { return 'org-current'; }
        }
      }
    },
    {
      file: '../src/modules/scoring/routes/results.js',
      route: '/getScoreResults',
      body: { activityId: 'missing-activity', dataType: 'overview', filters: {} },
      authorizedStatus: 'activity_not_found',
      mocks: {
        '../models/scoreActivity': {
          async getById() { return null; }
        },
        '../../../utils/orgContext': {
          async getCurrentOrgId() { return 'org-current'; }
        }
      }
    },
    {
      file: '../src/modules/scoring/routes/scoring.js',
      route: '/getScorerTaskStatus',
      body: { activityId: 'missing-activity', filters: {} },
      authorizedStatus: 'activity_not_found',
      mocks: scoringRouteMocks
    },
    {
      file: '../src/modules/scoring/routes/publications.js',
      route: '/getResultPublication',
      body: {},
      authorizedStatus: 'invalid_params',
      mocks: {}
    }
  ];

  for (const testCase of cases) await verifyAdminResolution(testCase);

  const failedActivities = loadRoute('../src/modules/scoring/routes/activities.js', {
    '../models/scoreActivity': {
      async getAll() { throw new Error('fixture failure'); }
    }
  });
  const failedActivityResult = await invoke(failedActivities.router, '/listScoreActivities', {
    admin: { id: 'grant-admin', admin_level: 'super_admin' }
  });
  assert.strictEqual(failedActivityResult.status, 'error', '活动列表异常必须返回明确错误状态');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(failedActivityResult, 'list'), false,
    '活动列表异常不得伪装为空列表');

  const scoringLoaded = loadRoute('../src/modules/scoring/routes/scoring.js', scoringRouteMocks);
  const userResult = await invoke(scoringLoaded.router, '/getRateTargets', {
    body: {},
    get() { return 'user'; }
  });
  assert.strictEqual(userResult.status, 'invalid_scorer', '评分用户路径应继续使用当前岗位参与人解析');
  assert.strictEqual(scoringLoaded.state.lookupCalls, 0, '评分用户路径不得查询旧管理员表');

  console.log('评分管理路由请求主体兼容测试通过');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
