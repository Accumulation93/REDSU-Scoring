'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const mysql = require('mysql2/promise');

async function run() {
  if (!process.env.DEPLOY_TEST_DB_HOST) {
    console.log('未配置隔离数据库，印章岗位授权数据库测试未执行');
    return;
  }
  const database = 'whusu_stamp_test_' + Date.now() + '_' + process.pid;
  assert(/^whusu_stamp_test_\d+_\d+$/.test(database));
  const config = { host: process.env.DEPLOY_TEST_DB_HOST, port: Number(process.env.DEPLOY_TEST_DB_PORT || 3306),
    user: process.env.DEPLOY_TEST_DB_USER || 'root', password: process.env.DEPLOY_TEST_DB_PASSWORD || '' };
  const admin = await mysql.createConnection(config);
  let db;
  try {
    await admin.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    db = mysql.createPool(Object.assign({}, config, { database, connectionLimit: 5 }));
    const definitions = [
      'persons (id VARCHAR(64) PRIMARY KEY, name VARCHAR(100), student_id VARCHAR(64), status VARCHAR(24))',
      'organization_memberships (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64), person_id VARCHAR(64), status VARCHAR(24))',
      'departments (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64), name VARCHAR(100))',
      'identities (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64), name VARCHAR(100))',
      'work_groups (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64), name VARCHAR(100))',
      'membership_assignments (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64), membership_id VARCHAR(64), assignment_kind VARCHAR(32), department_id VARCHAR(64), identity_id VARCHAR(64), work_group_id VARCHAR(64), status VARCHAR(24))',
      'stamps (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64), name VARCHAR(100), image_data LONGTEXT)'
    ];
    for (const definition of definitions) await db.query('CREATE TABLE ' + definition + ' ENGINE=InnoDB');
    const migration = fs.readFileSync(path.join(__dirname, '../db/deploy/20260906123000_stamp_person_assignment_grants.sql'), 'utf8');
    await db.query(migration);
    await db.query(migration);
    await db.query("INSERT INTO persons VALUES ('p1','同名','test-private-1','active'),('p2','同名','test-private-2','active')");
    await db.query("INSERT INTO organization_memberships VALUES ('m1','o1','p1','active'),('m2','o1','p2','active'),('m3','o2','p1','active')");
    await db.query("INSERT INTO departments VALUES ('d1','o1','部门甲'),('d2','o2','部门乙')");
    await db.query("INSERT INTO identities VALUES ('i1','o1','负责人'),('i2','o2','负责人'),('i3','o1','成员')");
    await db.query("INSERT INTO membership_assignments VALUES ('a1','o1','m1','staff','d1','i1',NULL,'active'),('a2','o1','m1','staff','d1','i3',NULL,'active'),('a3','o1','m2','staff','d1','i1',NULL,'active'),('a4','o2','m3','staff','d2','i2',NULL,'active')");
    await db.query("INSERT INTO stamps VALUES ('s1','o1','同名章','image-one'),('s2','o2','同名章','image-two')");
    let orgId = 'o1';
    let rejectCommit = false;
    const realDb = { query: (...args) => db.query(...args), withTransaction: async fn => {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const result = await fn(connection);
        if (rejectCommit) throw new Error('模拟提交前失败');
        await connection.commit();
        return result;
      }
      catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    } };
    const originalLoad = Module._load;
    Module._load = function(request, parent, main) {
      if (request === '../../../config/db') return realDb;
      if (request === '../../../utils/orgContext') return { getCurrentOrgId: async () => orgId };
      if (request === '../../../core/models/hrMemberDeletion') return { lockPersonDeletionBarrier: async (connection, personId) => {
        const [rows] = await connection.query("SELECT id FROM persons WHERE id = ? AND status = 'active' FOR UPDATE", [personId]);
        return Boolean(rows.length);
      } };
      return originalLoad.call(this, request, parent, main);
    };
    let model;
    try { model = require('../src/modules/audit/models/stampAssignmentGrant'); } finally { Module._load = originalLoad; }
    const actor = { assignment_id: 'a1', person_id: 'p1', org_id: 'o1' };
    assert.deepStrictEqual(await model.getAuthorizedStamps(actor), []);
    const candidates = await model.listCandidates();
    assert.deepStrictEqual(candidates.map(row => row.assignmentId).sort(), ['a1', 'a2', 'a3']);
    assert(!JSON.stringify(candidates).includes('student') && !JSON.stringify(candidates).includes('test-private'));
    assert.strictEqual((await model.replaceForStamp('s1', ['a1', 'a1', 'a3'])).status, 'success');
    assert.strictEqual((await model.listGrants()).length, 2, '去重且同名人员保持独立');
    assert.strictEqual((await model.getAuthorizedStamps(actor))[0].id, 's1');
    assert.deepStrictEqual(await model.getAuthorizedStamps(Object.assign({}, actor, { assignment_id: 'a2' })), []);
    assert.deepStrictEqual(await model.getAuthorizedStamps(Object.assign({}, actor, { person_id: 'p2' })), []);
    for (const values of [null, 'a1', [null], [''], new Array(1001).fill('a1')]) {
      assert.strictEqual((await model.replaceForStamp('s1', values)).status, 'invalid_params');
    }
    assert.strictEqual((await model.replaceForStamp('s1', ['a1', 'a4'])).status, 'assignment_unavailable');
    assert.strictEqual((await model.replaceForStamp('s2', ['a1'])).status, 'stamp_not_found');
    assert.strictEqual((await model.listGrants()).length, 2, '任何无效项不能部分清空旧授权');
    rejectCommit = true;
    await assert.rejects(model.replaceForStamp('s1', ['a2']), /模拟提交前失败/);
    rejectCommit = false;
    assert.deepStrictEqual((await model.listGrants()).map(row => row.assignmentId).sort(), ['a1', 'a3'], '失败必须回滚整组授权');
    await db.query("UPDATE organization_memberships SET person_id='p2' WHERE id='m1'");
    assert.deepStrictEqual(await model.getAuthorizedStamps(actor), [], '自然人合并或关联变化不得继承旧授权');
    assert.deepStrictEqual(await model.getAuthorizedStamps(Object.assign({}, actor, { person_id: 'p2' })), []);
    await db.query("UPDATE organization_memberships SET person_id='p1' WHERE id='m1'");
    await db.query("UPDATE membership_assignments SET status='revoked' WHERE id='a1'");
    assert.deepStrictEqual(await model.getAuthorizedStamps(actor), []);
    assert.strictEqual((await model.listGrants()).find(row => row.assignmentId === 'a1').available, false);
    await db.query("UPDATE membership_assignments SET status='active' WHERE id='a1'");
    await db.query("UPDATE organization_memberships SET status='departed' WHERE id='m1'");
    assert.deepStrictEqual(await model.getAuthorizedStamps(actor), []);
    await db.query("UPDATE organization_memberships SET status='active' WHERE id='m1'");
    await realDb.withTransaction(async connection => {
      assert.strictEqual((await model.getAuthorizedStamps(actor, ['s1'], connection)).length, 1);
      assert.deepStrictEqual(await model.getAuthorizedStamps(actor, ['s2'], connection), []);
    });
    orgId = 'o2';
    assert.deepStrictEqual(await model.getAuthorizedStamps(actor), []);
    assert.deepStrictEqual(await model.listGrants(), []);
    assert.strictEqual((await model.replaceForStamp('s1', ['a4'])).status, 'stamp_not_found');
    orgId = 'o1';
    await model.replaceForStamp('s1', []);
    assert.deepStrictEqual(await model.getAuthorizedStamps(actor), []);
    console.log('印章授权真实 MySQL 测试通过：幂等迁移、同名、同人多岗、跨组织、无效项整批拒绝、离任、事务盖章和清空');
  } finally {
    if (db) await db.end();
    await admin.query('DROP DATABASE IF EXISTS `' + database + '`');
    await admin.end();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
