const assert = require('assert');
const mysql = require('mysql2/promise');
const Module = require('module');
const fs = require('fs');
const path = require('path');

if (!process.env.DEPLOY_TEST_DB_HOST) {
  console.log('未配置 DEPLOY_TEST_DB_HOST，跳过本人资料真实数据库测试');
  process.exit(0);
}

async function run() {
  const databaseName = `whusu_self_hr_${Date.now()}_${process.pid}`;
  const connection = await mysql.createConnection({
    host: process.env.DEPLOY_TEST_DB_HOST,
    port: Number(process.env.DEPLOY_TEST_DB_PORT || 3306),
    user: process.env.DEPLOY_TEST_DB_USER || 'root',
    password: process.env.DEPLOY_TEST_DB_PASSWORD || '', timezone: 'Z'
  });
  try {
    await connection.query(`CREATE DATABASE \`${databaseName}\``);
    await connection.query(`USE \`${databaseName}\``);
    await connection.query('CREATE TABLE persons (id VARCHAR(64) PRIMARY KEY, status VARCHAR(24))');
    await connection.query('CREATE TABLE hr_info (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64), name VARCHAR(64))');
    await connection.query('CREATE TABLE organization_memberships (id VARCHAR(64) PRIMARY KEY, person_id VARCHAR(64), org_id VARCHAR(64), legacy_hr_id VARCHAR(64), status VARCHAR(24), created_at DATETIME(3), UNIQUE KEY (person_id, org_id))');
    await connection.query('INSERT INTO persons VALUES (?, ?), (?, ?)', ['person-a', 'active', 'person-b', 'active']);
    for (const [id, person, org, hrId, status] of [
      ['member-a', 'person-a', 'org-a', 'hr-a', 'active'],
      ['member-b', 'person-a', 'org-b', 'hr-b', 'active'],
      ['member-c', 'person-b', 'org-a', 'hr-c', 'active']
    ]) {
      await connection.query('INSERT INTO organization_memberships VALUES (?, ?, ?, ?, ?, NOW(3))', [id, person, org, hrId, status]);
      await connection.query('INSERT INTO hr_info VALUES (?, ?, ?)', [hrId, org, 'fixture']);
    }
    const filename = path.resolve(__dirname, '../src/core/models/hrInfo.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.require = (name) => {
      if (name === '../../config/db') return connection;
      if (name === '../../utils/orgContext') return {};
      if (name === './unifiedIdentity') return {};
      throw new Error('未声明的测试依赖 ' + name);
    };
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    const lookup = loaded.exports.getActiveByPersonIdInOrg;
    // 没有 user_info 或岗位表也能读取本人档案，且同人与他人、同组织与跨组织严格区分。
    assert.strictEqual((await lookup('person-a', 'org-a')).id, 'hr-a');
    assert.strictEqual((await lookup('person-a', 'org-b')).id, 'hr-b');
    assert.strictEqual((await lookup('person-b', 'org-a')).id, 'hr-c');
    assert.strictEqual(await lookup('person-b', 'org-b'), null);
    assert.strictEqual(await lookup("person-a' OR 1=1 --", 'org-a'), null);
    assert.strictEqual(await lookup('', 'org-a'), null);
    await connection.query('UPDATE organization_memberships SET status = ? WHERE id = ?', ['left', 'member-a']);
    assert.strictEqual(await lookup('person-a', 'org-a'), null);
    await connection.query('UPDATE organization_memberships SET status = ? WHERE id = ?', ['active', 'member-a']);
    await connection.query('UPDATE persons SET status = ? WHERE id = ?', ['merged', 'person-a']);
    assert.strictEqual(await lookup('person-a', 'org-a'), null);
    await connection.query('UPDATE persons SET status = ? WHERE id = ?', ['active', 'person-a']);
    await connection.query('UPDATE hr_info SET org_id = ? WHERE id = ?', ['org-b', 'hr-a']);
    assert.strictEqual(await lookup('person-a', 'org-a'), null);
    console.log('本人资料真实 MySQL 自然人、在职成员与租户隔离测试通过');
  } finally {
    await connection.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await connection.end();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
