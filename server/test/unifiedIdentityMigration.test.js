const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

if (!process.env.DEPLOY_TEST_DB_HOST) {
  console.log('未配置 DEPLOY_TEST_DB_HOST，跳过统一身份迁移集成测试');
  process.exit(0);
}

const databaseName = `whusu_unified_identity_test_${Date.now()}_${process.pid}`;
const baseConfig = {
  host: process.env.DEPLOY_TEST_DB_HOST,
  port: Number(process.env.DEPLOY_TEST_DB_PORT || 3306),
  user: process.env.DEPLOY_TEST_DB_USER || 'root',
  password: process.env.DEPLOY_TEST_DB_PASSWORD || ''
};
const runtimeUser = baseConfig.password ? baseConfig.user : `unified_${process.pid}`;
const runtimePassword = baseConfig.password || `Unified-${process.pid}-Test!`;
let createdRuntimeUser = false;

const legacySchema = `
CREATE TABLE organizations (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE departments (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE identities (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE work_groups (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE hr_info (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  student_id VARCHAR(32) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  department_id VARCHAR(64) DEFAULT NULL,
  identity_id VARCHAR(64) DEFAULT NULL,
  work_group_id VARCHAR(64) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE user_info (
  id VARCHAR(64) PRIMARY KEY,
  openid VARCHAR(128) NOT NULL,
  hr_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME DEFAULT NULL,
  UNIQUE KEY uk_user_org_openid (org_id, openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE admin_info (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  student_id VARCHAR(32) NOT NULL,
  openid VARCHAR(128) DEFAULT NULL,
  org_id VARCHAR(64) NOT NULL DEFAULT '',
  admin_level VARCHAR(32) NOT NULL,
  bind_status VARCHAR(24) DEFAULT 'active',
  invite_code VARCHAR(64) DEFAULT NULL,
  invite_expires_at DATETIME DEFAULT NULL,
  bound_at DATETIME DEFAULT NULL,
  updated_at DATETIME DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE score_activities (
  id VARCHAR(64) PRIMARY KEY,
  is_current TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE score_records (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL,
  activity_id VARCHAR(64) NOT NULL,
  scorer_id VARCHAR(64) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  UNIQUE KEY uk_sr_business (org_id, activity_id, scorer_id, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE audit_events (
  id VARCHAR(64) PRIMARY KEY,
  operator_hr_id VARCHAR(64) DEFAULT NULL,
  operator_name VARCHAR(100) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE venue_bookings (
  id VARCHAR(64) PRIMARY KEY,
  user_hr_id VARCHAR(64) DEFAULT NULL,
  approver_hr_id VARCHAR(64) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const seedSql = `
INSERT INTO organizations VALUES
  ('org-a', '组织甲', NOW()),
  ('org-b', '组织乙', DATE_SUB(NOW(), INTERVAL 1 DAY)),
  ('org-c', '组织丙', DATE_SUB(NOW(), INTERVAL 2 DAY));
INSERT INTO hr_info VALUES
  ('hr-a1', '同一人', '20260001', 'org-a', 'dept-a', 'identity-a', ''),
  ('hr-b1', '同一人', '20260001', 'org-b', 'dept-b', 'identity-b', ''),
  ('hr-c1', '同一人', '20260001', 'org-c', NULL, NULL, ''),
  ('hr-a2', '第二人', '20260002', 'org-a', 'dept-a', 'identity-a', '');
INSERT INTO departments VALUES
  ('dept-a', 'org-a', '主席团'),
  ('dept-b', 'org-b', '办公室');
INSERT INTO identities VALUES
  ('identity-a', 'org-a', '主席团成员'),
  ('identity-b', 'org-b', '学院对接人员');
INSERT INTO user_info VALUES
  ('user-a1', 'openid-one', 'hr-a1', 'org-a', NOW(), NOW()),
  ('user-b1', 'openid-one', 'hr-b1', 'org-b', NOW(), NOW()),
  ('user-a2', 'openid-two', 'hr-a2', 'org-a', NOW(), NOW());
INSERT INTO admin_info
  (id, name, student_id, openid, org_id, admin_level, bind_status, bound_at, updated_at)
VALUES ('admin-1', '同一人', '20260001', 'openid-one', '', 'super_admin', 'active', NOW(), NOW());
INSERT INTO score_activities VALUES ('activity-1', 1);
INSERT INTO score_records VALUES
  ('record-1', 'org-a', 'activity-1', 'hr-a1', 'hr-a2');
INSERT INTO audit_events VALUES ('event-1', 'hr-a1', '同一人');
INSERT INTO venue_bookings VALUES ('booking-1', 'hr-a1', 'hr-a2');
`;

async function run() {
  const admin = await mysql.createConnection(baseConfig);
  let database;
  try {
    await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (!baseConfig.password) {
      await admin.query(
        `CREATE USER \`${runtimeUser}\`@\`%\` IDENTIFIED BY ?`,
        [runtimePassword]
      );
      createdRuntimeUser = true;
      await admin.query(
        `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO \`${runtimeUser}\`@\`%\``
      );
    }
    database = await mysql.createConnection(Object.assign({}, baseConfig, {
      database: databaseName,
      multipleStatements: true
    }));
    await database.query(legacySchema);
    await database.query(seedSql);
    await database.query(fs.readFileSync(
      path.resolve(__dirname, '../db/deploy/20260729100000_unified_identity_auth.sql'),
      'utf8'
    ));
    // 设备字段由后续独立迁移负责；在本测试夹具中补齐它们，验证统一身份模型
    // 在旧库完成身份迁移后也能安全创建带设备信息的会话。
    await database.query(`
      ALTER TABLE auth_sessions
        ADD COLUMN device_key_hash CHAR(64) DEFAULT NULL,
        ADD COLUMN device_platform VARCHAR(24) DEFAULT NULL,
        ADD COLUMN device_model VARCHAR(96) DEFAULT NULL,
        ADD COLUMN binding_mode VARCHAR(24) NOT NULL DEFAULT 'bound' AFTER token_version,
        ADD COLUMN openid_ciphertext TEXT NULL AFTER binding_mode,
        ADD INDEX idx_auth_session_device (account_id, device_key_hash, status);
      ALTER TABLE organization_memberships
        ADD COLUMN departure_batch_id VARCHAR(64) DEFAULT NULL;
      ALTER TABLE membership_assignments
        ADD COLUMN revoked_by_departure_id VARCHAR(64) DEFAULT NULL,
        ADD INDEX idx_assignment_departure (membership_id, status, revoked_by_departure_id)
    `);

    const [[counts]] = await database.query(`
      SELECT
        (SELECT COUNT(*) FROM persons) AS persons,
        (SELECT COUNT(*) FROM organization_memberships) AS memberships,
        (SELECT COUNT(*) FROM membership_assignments) AS assignments,
        (SELECT COUNT(*) FROM accounts) AS accounts,
        (SELECT COUNT(*) FROM account_wechat_bindings) AS bindings,
        (SELECT COUNT(*) FROM admin_grants) AS grants
    `);
    assert.deepStrictEqual(
      Object.values(counts).map(Number),
      [2, 4, 4, 2, 2, 1]
    );

    const [[record]] = await database.query(
      'SELECT scorer_subject_key, target_subject_key FROM score_records WHERE id = ?',
      ['record-1']
    );
    assert.match(record.scorer_subject_key, /^person:/);
    assert.match(record.target_subject_key, /^person:/);

    await database.query(fs.readFileSync(
      path.resolve(__dirname, '../db/deploy/20260730143000_remove_primary_assignment.sql'),
      'utf8'
    ));
    const [primaryColumns] = await database.query(`
      SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'membership_assignments'
         AND COLUMN_NAME IN ('is_primary', 'active_primary_membership_id')
    `, [databaseName]);
    assert.deepStrictEqual(primaryColumns, []);
    await database.query(fs.readFileSync(
      path.resolve(__dirname, '../db/deploy/20260730143000_remove_primary_assignment.sql'),
      'utf8'
    ));
    await assert.rejects(
      database.query(`
        INSERT INTO account_wechat_bindings
          (id, account_id, openid_hash, status, active_account_id)
        VALUES ('binding-conflict', 'user-a1', SHA2('another-openid', 256), 'active', 'user-a1')
      `),
      /Duplicate entry/
    );

    await database.end();
    database = null;

    process.env.DB_HOST = baseConfig.host;
    process.env.DB_PORT = String(baseConfig.port);
    process.env.DB_USER = runtimeUser;
    process.env.DB_PASSWORD = runtimePassword;
    process.env.DB_NAME = databaseName;
    process.env.AUTH_IDENTITY_SECRET = 'unified-identity-migration-test-secret';
    const identityModel = require('../src/core/models/unifiedIdentity');
    const pool = require('../src/config/db');
    const upgraded = await identityModel.upgradeLegacyWechatBindings();
    assert.strictEqual(upgraded.upgraded, 2);
    const account = await identityModel.findAccountByOpenid('openid-one');
    assert(account);
    const session = await identityModel.createSession(account, '', {
      requestId: 'request-login-sync',
      ip: '127.0.0.1'
    });
    assert(session && session.context);
    const contexts = await identityModel.listContexts(account.id);
    assert.strictEqual(contexts.some((item) => Object.prototype.hasOwnProperty.call(item, 'isPrimary')), false);
    const globalAdminContexts = contexts.filter((item) => item.identityScope === 'global');
    assert.strictEqual(globalAdminContexts.length, 3);
    assert.strictEqual(
      new Set(globalAdminContexts.map((item) => item.authIdentityId)).size,
      1
    );
    const targetGlobalContext = globalAdminContexts.find((item) => item.organizationId === 'org-b');
    assert(targetGlobalContext);
    // 口令会话与微信会话使用同一自然人目录，解绑材料缺失不得让口令会话换人。
    const passwordOptions = identityModel.temporaryPasswordSessionOptions('');
    const passwordSession = await identityModel.createSession(account, {
      contextId: session.context.contextId
    }, { requestId: 'password-parity', ip: '127.0.0.1' }, passwordOptions);
    assert.strictEqual(passwordSession.context.contextId, session.context.contextId);
    assert.strictEqual(passwordSession.bindingMode, 'temporary');
    const [activeBindings] = await pool.query("SELECT id FROM account_wechat_bindings WHERE account_id = ? AND status = 'active'", [account.id]);
    assert.strictEqual(activeBindings.length, 1);
    await pool.query("UPDATE account_wechat_bindings SET status = 'revoked', active_account_id = NULL WHERE id = ?", [activeBindings[0].id]);
    const { usableLoginCredentialSql } = require('../src/core/models/accountLoginState');
    const readLoginAbility = async () => {
      const [[row]] = await pool.query(`SELECT ${usableLoginCredentialSql('a')} AS available FROM accounts a WHERE a.id = ?`, [account.id]);
      return Number(row.available);
    };
    assert.strictEqual(await readLoginAbility(), 0);
    const [[previousPolicy]] = await pool.query("SELECT allow_passphrase FROM auth_policy WHERE id = 'default'");
    await pool.query("UPDATE auth_policy SET allow_passphrase = 1 WHERE id = 'default'");
    const { hashPassphrase } = require('../src/core/services/identityCrypto');
    const fixturePassphrase = 'Unified-parity-fixture-2026';
    const fixtureCredential = hashPassphrase(fixturePassphrase);
    await pool.query("INSERT INTO account_recovery_credentials (id, account_id, method, credential_hash, salt, status) VALUES (?, ?, 'passphrase', ?, ?, 'active')", [
      'parity-login-credential', account.id, fixtureCredential.hash, fixtureCredential.salt
    ]);
    assert.strictEqual(await readLoginAbility(), 1, '未绑定微信但启用口令的管理员必须计入可登录人数');
    await pool.query("UPDATE auth_policy SET allow_passphrase = 0 WHERE id = 'default'");
    assert.strictEqual(await readLoginAbility(), 0, '全局关闭口令时不能错误计算为可登录');
    await pool.query("UPDATE auth_policy SET allow_passphrase = 1 WHERE id = 'default'");
    await pool.query("UPDATE account_recovery_credentials SET locked_until = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE id = 'parity-login-credential'");
    assert.strictEqual(await readLoginAbility(), 0, '锁定中的口令不能冒充可用登录凭据');
    await pool.query("DELETE FROM account_recovery_credentials WHERE id = 'parity-login-credential'");
    await pool.query("UPDATE auth_policy SET allow_passphrase = ? WHERE id = 'default'", [previousPolicy.allow_passphrase]);
    assert.strictEqual(await identityModel.loadSession(session.id), null, '微信凭据失效后微信会话必须拒绝');
    const loadedPassword = await identityModel.loadSession(passwordSession.id);
    assert.strictEqual(loadedPassword.context.personId, account.person_id);
    assert.strictEqual(loadedPassword.openid, '');
    const switchedPassword = await identityModel.activateSelection(passwordSession.id, account.id, {
      contextId: targetGlobalContext.contextId
    });
    assert.strictEqual(switchedPassword.contextId, targetGlobalContext.contextId);
    const unboundPasswordSession = await identityModel.createSession(account, {
      contextId: targetGlobalContext.contextId
    }, {}, identityModel.temporaryPasswordSessionOptions('unrelated-wechat'));
    assert.strictEqual(unboundPasswordSession.context.personId, account.person_id);
    await assert.rejects(identityModel.createSession(account, '', {}), (error) => error.code === 'binding_missing');
    await pool.query("UPDATE account_wechat_bindings SET status = 'active', active_account_id = account_id WHERE id = ?", [activeBindings[0].id]);
    for (const status of ['frozen', 'recovery_required']) {
      await pool.query('UPDATE accounts SET status = ? WHERE id = ?', [status, account.id]);
      assert.deepStrictEqual(await identityModel.listContexts(account.id), []);
      assert.strictEqual(await identityModel.loadSession(session.id), null);
      assert.strictEqual(await identityModel.loadSession(passwordSession.id), null);
      for (const options of [undefined, identityModel.temporaryPasswordSessionOptions('')]) {
        await assert.rejects(identityModel.createSession(account, '', {}, options), (error) => error.code === 'account_unavailable');
      }
      await assert.rejects(identityModel.activateSelection(passwordSession.id, account.id, {
        contextId: targetGlobalContext.contextId
      }), (error) => error.code === 'context_forbidden');
    }
    await pool.query("UPDATE accounts SET status = 'verified' WHERE id = ?", [account.id]);
    const activatedGlobalContext = await identityModel.activateSelection(
      session.id,
      account.id,
      {
        organizationId: 'org-b',
        identityId: targetGlobalContext.authIdentityId
      }
    );
    assert.strictEqual(activatedGlobalContext.contextId, targetGlobalContext.contextId);
    await assert.rejects(
      identityModel.activateSelection(session.id, account.id, {
        organizationId: 'org-not-allowed',
        identityId: targetGlobalContext.authIdentityId
      }),
      /该工作角色已失效/
    );
    await assert.rejects(
      identityModel.activateSelection(session.id, account.id, {
        organizationId: 'org-b',
        identityId: 'idn-forged'
      }),
      /该工作角色已失效/
    );
    await identityModel.revokeMembershipAssignment({
      id: 'hr-a1',
      organizationId: 'org-a'
    }, {
      personId: 'hr-a1',
      contextId: 'ctx-test-admin'
    });
    await pool.withTransaction(async (connection) => {
      await identityModel.syncLegacyHrRecords(connection, ['hr-a1']);
    });
    const [[revokedLegacyAssignment]] = await pool.query(
      `SELECT status FROM membership_assignments WHERE id = 'hr-a1'`
    );
    assert.strictEqual(revokedLegacyAssignment.status, 'revoked');
    const [[clearedLegacyFields]] = await pool.query(
      `SELECT department_id, identity_id, work_group_id FROM hr_info WHERE id = 'hr-a1'`
    );
    assert.strictEqual(clearedLegacyFields.department_id, null);
    assert.strictEqual(clearedLegacyFields.identity_id, null);
    assert.strictEqual(clearedLegacyFields.work_group_id, null);

    await identityModel.saveMembershipAssignment({
      legacyHrId: 'hr-a1',
      organizationId: 'org-a',
      assignmentKind: 'staff',
      title: '主席团成员',
      departmentId: 'dept-a',
      identityId: 'identity-a',
      workGroupId: ''
    }, {
      personId: 'hr-a1',
      contextId: 'ctx-test-admin'
    });
    await identityModel.saveMembershipAssignment({
      legacyHrId: 'hr-a1',
      organizationId: 'org-a',
      assignmentKind: 'liaison',
      title: '学院对接人员',
      departmentId: 'dept-a',
      identityId: 'identity-a',
      workGroupId: ''
    }, {
      personId: 'hr-a1',
      contextId: 'ctx-test-admin'
    });
    const assignments = await identityModel.listMembershipAssignments('hr-a1', 'org-a');
    assert.strictEqual(assignments.length, 2);
    assert.strictEqual(assignments.some((item) => Object.prototype.hasOwnProperty.call(item, 'is_primary')), false);
    const summaries = await identityModel.listMembershipAssignmentSummaries(['hr-a1'], 'org-a');
    assert.strictEqual(summaries.get('hr-a1').count, 2);
    assert.strictEqual(summaries.get('hr-a1').assignments.length, 2);
    assert(summaries.get('hr-a1').assignments.every((item) => (
      item.assignmentId && item.assignmentLabel && item.identityCategoryId
    )));
    await identityModel.revokeMembershipAssignment({
      id: assignments[0].id,
      organizationId: 'org-a'
    }, {
      personId: 'hr-a1',
      contextId: 'ctx-test-admin'
    });
    const [[compatibilitySnapshot]] = await pool.query(
      `SELECT department_id, identity_id
         FROM hr_info
        WHERE id = 'hr-a1' AND org_id = 'org-a'`
    );
    assert.strictEqual(compatibilitySnapshot.department_id, 'dept-a');
    assert.strictEqual(compatibilitySnapshot.identity_id, 'identity-a');
    const remainingAssignments = await identityModel.listMembershipAssignments('hr-a1', 'org-a');
    assert.strictEqual(remainingAssignments.length, 1);
    assert.deepStrictEqual(summaries.get('hr-a1').departments, ['主席团']);
    assert.deepStrictEqual(summaries.get('hr-a1').identities, ['主席团成员']);
    const [[syncedLegacyBinding]] = await pool.query(
      `SELECT COUNT(*) AS count
         FROM user_info
        WHERE openid = 'openid-one' AND org_id = 'org-c' AND hr_id = 'hr-c1'`
    );
    assert.strictEqual(Number(syncedLegacyBinding.count), 0, '登录和角色切换不得自动创建旧微信映射');
    const [[securityState]] = await pool.query(`
      SELECT
        SUM(legacy_openid IS NOT NULL) AS plaintext_count,
        SUM(openid_ciphertext IS NULL) AS missing_ciphertext,
        SUM(hash_version <> 'hmac_sha256_v1') AS legacy_hash_count
      FROM account_wechat_bindings
      WHERE status = 'active'
    `);
    assert.strictEqual(Number(securityState.plaintext_count), 0);
    assert.strictEqual(Number(securityState.missing_ciphertext), 0);
    assert.strictEqual(Number(securityState.legacy_hash_count), 0);

    await pool.query(`
      INSERT INTO identity_claim_requests
        (id, person_id, requested_org_id, openid_hash, status, expires_at)
      VALUES
        ('claim-batch-1', 'hr-a1', 'org-a', REPEAT('1', 64), 'pending', DATE_ADD(NOW(), INTERVAL 1 DAY)),
        ('claim-batch-2', 'hr-a2', 'org-a', REPEAT('2', 64), 'pending', DATE_ADD(NOW(), INTERVAL 1 DAY))
    `);
    const issued = await identityModel.issueVerificationCodes(
      ['claim-batch-1', 'claim-batch-2'],
      {
        personId: 'hr-a1',
        organizationId: 'org-a',
        contextId: 'ctx-test-admin',
        adminLevel: 'super_admin'
      },
      { requestId: 'request-batch-success', ip: '127.0.0.1' }
    );
    assert.strictEqual(issued.length, 2);
    assert.strictEqual(new Set(issued.map((item) => item.code)).size, 2);
    const revoked = await identityModel.revokeVerificationCodes(
      ['claim-batch-1'],
      {
        personId: 'hr-a1',
        organizationId: 'org-a',
        contextId: 'ctx-test-admin',
        adminLevel: 'super_admin'
      },
      { requestId: 'request-code-revoke', ip: '127.0.0.1' }
    );
    assert.deepStrictEqual(revoked, ['claim-batch-1']);
    const [[revokedState]] = await pool.query(
      `SELECT COUNT(*) AS count
         FROM identity_verification_tokens
        WHERE claim_request_id = 'claim-batch-1' AND status = 'active'`
    );
    assert.strictEqual(Number(revokedState.count), 0);
    await assert.rejects(
      identityModel.revokeVerificationCodes(
        ['claim-batch-2'],
        {
          personId: 'hr-a1',
          organizationId: 'org-b',
          contextId: 'ctx-wrong-org',
          adminLevel: 'admin'
        },
        { requestId: 'request-code-revoke-forbidden', ip: '127.0.0.1' }
      ),
      /请联系所属组织管理员/
    );
    const [[protectedState]] = await pool.query(
      `SELECT COUNT(*) AS count
         FROM identity_verification_tokens
        WHERE claim_request_id = 'claim-batch-2' AND status = 'active'`
    );
    assert.strictEqual(Number(protectedState.count), 1);

    await pool.query(`
      INSERT INTO identity_claim_requests
        (id, person_id, requested_org_id, openid_hash, status, expires_at)
      VALUES
        ('claim-batch-rollback', 'hr-a2', 'org-a', REPEAT('3', 64), 'pending', DATE_ADD(NOW(), INTERVAL 1 DAY))
    `);
    await assert.rejects(
      identityModel.issueVerificationCodes(
        ['claim-batch-rollback', 'claim-does-not-exist'],
        {
          personId: 'hr-a1',
          organizationId: 'org-a',
          contextId: 'ctx-test-admin',
          adminLevel: 'super_admin'
        },
        { requestId: 'request-batch-rollback', ip: '127.0.0.1' }
      ),
      /请刷新认证申请列表/
    );
    const [[rollbackState]] = await pool.query(
      `SELECT COUNT(*) AS count
         FROM identity_verification_tokens
        WHERE claim_request_id = 'claim-batch-rollback'`
    );
    assert.strictEqual(Number(rollbackState.count), 0);
    await pool.end();

    console.log('统一身份旧库回填、并发唯一约束、批量认证码事务与微信凭据加密迁移测试通过');
  } finally {
    if (database) await database.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    if (createdRuntimeUser) {
      await admin.query(`DROP USER IF EXISTS \`${runtimeUser}\`@\`%\``);
    }
    await admin.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
