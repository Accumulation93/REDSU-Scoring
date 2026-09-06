'use strict';

const crypto = require('crypto');
const forge = require('node-forge');
const { EVIDENCE_OID, MAX_MANIFEST_BYTES, fail, sha256, equalHex, canonicalBytes, assertManifest } = require('./signingProtocol');
const A = forge.asn1;
const O = { data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4',
  sha256: '2.16.840.1.101.3.4.2.1', rsa: '1.2.840.113549.1.1.1',
  rsaSha256: '1.2.840.113549.1.1.11', signingCertificateV2: '1.2.840.113549.1.9.16.2.47' };
const MAX_CMS_BYTES = 2 * 1024 * 1024;
const node = (type, constructed, value, tag = A.Class.UNIVERSAL) => A.create(tag, type, constructed, value);
const seq = value => node(A.Type.SEQUENCE, true, value);
const der = value => Buffer.from(A.toDer(value).getBytes(), 'binary');
const set = value => node(A.Type.SET, true, value.slice().sort((a, b) => Buffer.compare(der(a), der(b))));
// forge 的 OID 编解码限制为 32 位；UUID OID 的弧需要标准 base-128 任意精度编码。
function oid(value) {
  const arcs = value.split('.').map(BigInt);
  const values = [arcs[0] * 40n + arcs[1]].concat(arcs.slice(2));
  const bytes = [];
  for (let arc of values) {
    const encoded = [Number(arc & 127n)];
    while ((arc >>= 7n) > 0n) encoded.unshift(Number(arc & 127n) | 128);
    bytes.push(...encoded);
  }
  return node(A.Type.OID, false, Buffer.from(bytes).toString('binary'));
}
const octets = value => node(A.Type.OCTETSTRING, false, Buffer.from(value).toString('binary'));
const integer = value => node(A.Type.INTEGER, false, A.integerToDer(value).getBytes());
const context = (value, type = 0) => node(type, true, value, A.Class.CONTEXT_SPECIFIC);
const algorithm = value => seq([oid(value), node(A.Type.NULL, false, '')]);
const attr = (key, value) => seq([oid(key), set([value])]);
function oidValue(value) {
  if (!value || value.tagClass !== A.Class.UNIVERSAL || value.constructed || value.type !== A.Type.OID) return '';
  const arcs = [];
  let current = 0n;
  const bytes = Buffer.from(value.value, 'binary');
  if (!bytes.length || bytes.length > 64 || (bytes[bytes.length - 1] & 128)) fail('cms_oid_invalid');
  let firstByte = true;
  for (const byte of bytes) {
    if (firstByte && byte === 128) fail('cms_oid_invalid');
    current = (current << 7n) | BigInt(byte & 127);
    if (!(byte & 128)) { arcs.push(current); current = 0n; }
    firstByte = !(byte & 128);
  }
  const first = arcs.shift();
  const prefix = first >= 80n ? [2n, first - 80n] : first >= 40n ? [1n, first - 40n] : [0n, first];
  return prefix.concat(arcs).map(String).join('.');
}
const binary = value => Buffer.from(value.value, 'binary');
function universal(value, type, constructed) {
  return value && value.tagClass === A.Class.UNIVERSAL && value.type === type && value.constructed === constructed;
}
function validAlgorithm(value, allowed) {
  return universal(value, A.Type.SEQUENCE, true) && value.value.length >= 1 && value.value.length <= 2
    && allowed.includes(oidValue(value.value[0])) && (value.value.length === 1
      || (universal(value.value[1], A.Type.NULL, false) && value.value[1].value === ''));
}

// 在 ASN.1 库分配对象前限制长度、递归深度及节点数，拒绝非确定长度编码。
function inspectDer(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_CMS_BYTES) fail('cms_size_invalid');
  let nodes = 0;
  function walk(start, end, depth) {
    if (depth > 24) fail('cms_depth_exceeded');
    let pos = start;
    while (pos < end) {
      if (++nodes > 20000 || pos + 2 > end) fail('cms_structure_invalid');
      const tag = bytes[pos++];
      if ((tag & 31) === 31) fail('cms_tag_unsupported');
      let length = bytes[pos++];
      if (length & 128) {
        const count = length & 127;
        if (!count || count > 4 || pos + count > end || bytes[pos] === 0) fail('cms_length_invalid');
        length = 0;
        for (let i = 0; i < count; i += 1) length = length * 256 + bytes[pos++];
        if (length < 128) fail('cms_length_invalid');
      }
      if (pos + length > end) fail('cms_length_invalid');
      if (tag & 32) walk(pos, pos + length, depth + 1);
      pos += length;
    }
    if (pos !== end) fail('cms_length_invalid');
  }
  walk(0, bytes.length, 0);
}
function parse(bytes) {
  inspectDer(bytes);
  try { return A.fromDer(forge.util.createBuffer(bytes.toString('binary')), { strict: true, parseAllBytes: true }); }
  catch (_) { return fail('cms_structure_invalid'); }
}
function certificateParts(certDer) {
  const cert = parse(certDer);
  const tbs = cert.value[0].value;
  const offset = tbs[0].tagClass === A.Class.CONTEXT_SPECIFIC ? 1 : 0;
  return { cert, serial: tbs[offset], issuer: tbs[offset + 2], subject: tbs[offset + 4] };
}
function validateIdentity(identity) {
  const cert = new crypto.X509Certificate(identity.certificatePem);
  const key = crypto.createPrivateKey(identity.privateKeyPem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048
    || !crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(cert.publicKey.export({ type: 'spki', format: 'der' }))) fail('signing_key_invalid');
  if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) fail('signing_certificate_expired');
  return { cert, key };
}
function signCms(content, identity, options = {}) {
  const { cert, key } = validateIdentity(identity);
  const parts = certificateParts(cert.raw);
  const attrs = [attr(O.contentType, oid(O.data)), attr(O.messageDigest, octets(Buffer.from(sha256(content), 'hex'))),
    attr(O.signingCertificateV2, seq([seq([seq([octets(Buffer.from(sha256(cert.raw), 'hex'))])])]))];
  if (options.manifest) {
    const manifestBytes = assertManifest(options.manifest);
    attrs.push(attr(EVIDENCE_OID, octets(canonicalBytes({ manifest: options.manifest, sha256: sha256(manifestBytes) }))));
  }
  const signedAttrs = set(attrs);
  const signature = crypto.sign('sha256', der(signedAttrs), key);
  const signerInfo = seq([integer(1), seq([parts.issuer, parts.serial]), algorithm(O.sha256),
    context(signedAttrs.value), algorithm(O.rsa), octets(signature)]);
  const certNodes = [parts.cert];
  const chain = String(identity.certificateChainPem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  chain.forEach(pem => {
    const chainCert = new crypto.X509Certificate(pem);
    if (!chainCert.raw.equals(cert.raw)) certNodes.push(parse(chainCert.raw));
  });
  const eContent = options.encapsulated ? [oid(O.data), context([octets(content)])] : [oid(O.data)];
  const encoded = der(seq([oid(O.signedData), context([seq([integer(1), set([algorithm(O.sha256)]),
    seq(eContent), context(set(certNodes).value), set([signerInfo])])])]));
  if (encoded.length > MAX_CMS_BYTES) fail('cms_size_invalid');
  return encoded;
}
function oneAttribute(attrs, name, required = true) {
  const entries = attrs.filter(item => oidValue(item.value && item.value[0]) === name);
  if (entries.length !== 1) {
    if (!required && !entries.length) return null;
    return fail('cms_attribute_invalid');
  }
  const values = entries[0].value[1];
  if (!values || values.type !== A.Type.SET || values.value.length !== 1) fail('cms_attribute_invalid');
  return values.value[0];
}
function verifyCms(cmsDer, detachedContent, options = {}) {
  try {
    const root = parse(cmsDer);
    if (!universal(root, A.Type.SEQUENCE, true) || oidValue(root.value[0]) !== O.signedData || root.value.length !== 2
      || root.value[1].tagClass !== A.Class.CONTEXT_SPECIFIC || root.value[1].type !== 0
      || !root.value[1].constructed || root.value[1].value.length !== 1
      || !universal(root.value[1].value[0], A.Type.SEQUENCE, true)) fail('cms_content_type_invalid');
    const body = root.value[1].value[0].value;
    if (body.length !== 5 || !universal(body[0], A.Type.INTEGER, false) || body[0].value !== '\x01') fail('cms_structure_invalid');
    if (body[1].type !== A.Type.SET || body[1].value.length !== 1
      || !validAlgorithm(body[1].value[0], [O.sha256])) fail('cms_algorithm_unsupported');
    if (oidValue(body[2].value[0]) !== O.data) fail('cms_content_type_invalid');
    const embedded = body[2].value[1];
    const content = embedded ? binary(embedded.value[0]) : detachedContent;
    if (!Buffer.isBuffer(content)) fail('cms_content_missing');
    if (embedded && detachedContent && !content.equals(detachedContent)) fail('cms_content_mismatch');
    const certContainer = body.filter(item => item.tagClass === A.Class.CONTEXT_SPECIFIC && item.type === 0);
    const signers = body[body.length - 1];
    if (certContainer.length !== 1 || signers.type !== A.Type.SET || signers.value.length !== 1) fail('cms_signer_invalid');
    const si = signers.value[0].value;
    if (si.length !== 6 || !universal(si[0], A.Type.INTEGER, false) || si[0].value !== '\x01'
      || !validAlgorithm(si[2], [O.sha256]) || !validAlgorithm(si[4], [O.rsa, O.rsaSha256])
      || !universal(si[5], A.Type.OCTETSTRING, false)) fail('cms_algorithm_unsupported');
    const sid = si[1];
    if (sid.type !== A.Type.SEQUENCE || sid.value.length !== 2) fail('cms_signer_invalid');
    const matching = certContainer[0].value.filter(candidate => {
      const part = certificateParts(der(candidate));
      return der(part.issuer).equals(der(sid.value[0])) && der(part.serial).equals(der(sid.value[1]));
    });
    if (matching.length !== 1) fail('cms_certificate_not_found');
    const cert = new crypto.X509Certificate(der(matching[0]));
    if (cert.publicKey.asymmetricKeyType !== 'rsa' || cert.publicKey.asymmetricKeyDetails.modulusLength < 2048) fail('cms_key_unsupported');
    if (si[3].tagClass !== A.Class.CONTEXT_SPECIFIC || si[3].type !== 0) fail('cms_attributes_missing');
    const attrs = si[3].value;
    if (!Array.isArray(attrs) || attrs.some(item => !universal(item, A.Type.SEQUENCE, true)
      || item.value.length !== 2 || !oidValue(item.value[0]) || !universal(item.value[1], A.Type.SET, true))) fail('cms_attribute_invalid');
    const types = attrs.map(item => oidValue(item.value[0]));
    if (new Set(types).size !== types.length) fail('cms_attribute_duplicate');
    if (oidValue(oneAttribute(attrs, O.contentType)) !== O.data) fail('cms_content_type_invalid');
    const expected = oneAttribute(attrs, O.messageDigest);
    if (expected.type !== A.Type.OCTETSTRING || !equalHex(binary(expected).toString('hex'), sha256(content))) fail('cms_digest_mismatch');
    const sorted = set(attrs);
    if (!der(context(sorted.value)).equals(der(si[3]))) fail('cms_attributes_not_der');
    if (!crypto.verify('sha256', der(sorted), cert.publicKey, binary(si[5]))) fail('cms_signature_invalid');
    const binding = oneAttribute(attrs, O.signingCertificateV2, false);
    if (binding) {
      const ess = binding.value[0].value[0].value;
      const hashNode = ess[0].type === A.Type.SEQUENCE ? ess[1] : ess[0];
      if ((ess[0].type === A.Type.SEQUENCE && oidValue(ess[0].value[0]) !== O.sha256)
        || hashNode.type !== A.Type.OCTETSTRING || !equalHex(binary(hashNode).toString('hex'), sha256(cert.raw))) fail('cms_certificate_binding_invalid');
    } else if (options.requireBinding) fail('cms_certificate_binding_missing');
    const evidence = oneAttribute(attrs, EVIDENCE_OID, false);
    let manifest = null;
    if (evidence) {
      if (!binding || evidence.type !== A.Type.OCTETSTRING || binary(evidence).length > MAX_MANIFEST_BYTES + 256) fail('evidence_manifest_invalid');
      const encoded = binary(evidence);
      const value = JSON.parse(encoded.toString('utf8'));
      if (!encoded.equals(canonicalBytes(value)) || !equalHex(value.sha256, sha256(assertManifest(value.manifest)))) fail('evidence_manifest_invalid');
      manifest = value.manifest;
    }
    return { ok: true, reasonCode: 'cms_signature_valid', content, manifest,
      certificatePem: cert.toString(), certificateFingerprint: sha256(cert.raw), certificateBound: Boolean(binding),
      certificateValidFrom: new Date(cert.validFrom).toISOString(), certificateValidTo: new Date(cert.validTo).toISOString(),
      certificateTimeValid: Date.now() >= Date.parse(cert.validFrom) && Date.now() <= Date.parse(cert.validTo),
      // 名称仅供诊断，不作为身份授权来源。旧证书学号不进入响应。
      signerName: (cert.subject.split('\n').find(line => line.startsWith('CN=')) || '').slice(3).replace(/（[^（）]*）$/, ''),
      algorithm: 'RSA-SHA256', trustStatus: 'not_evaluated', trusted: false };
  } catch (error) {
    return { ok: false, reasonCode: error.code || 'cms_structure_invalid', manifest: null, trusted: false };
  }
}

module.exports = { signCms, verifyCms, MAX_CMS_BYTES, inspectDer, validateIdentity };
