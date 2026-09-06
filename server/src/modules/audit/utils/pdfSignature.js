'use strict';

const localeCopy = require('../../../locales/zh-CN/generated/modules/audit/utils/pdfSignature');
const crypto = require('crypto');
const fs = require('fs');
const forge = require('node-forge');

// node-forge 的 RSA PKCS#1 v1.5 签名填充在 Node 22+ 下损坏（OpenSSL 严格校验
// 会报 invalid padding）。证书与 CMS 签名一律改用 Node 原生 crypto.sign/verify。
// 证书 DN 的 UTF-8 编解码也改用 Buffer 显式实现。
forge.util.encodeUtf8 = function encodeUtf8(str) {
  if (typeof str !== 'string') return str;
  return Buffer.from(str, 'utf8').toString('binary');
};
forge.util.decodeUtf8 = function decodeUtf8(bytes) {
  if (typeof bytes !== 'string') return bytes;
  return Buffer.from(bytes, 'binary').toString('utf8');
};

const asn1 = forge.asn1;
const pki = forge.pki;
const OIDS = forge.pki.oids;

function sha256Bytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function aInteger(value) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(value).getBytes());
}

function aIntegerBytes(bytes) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, bytes);
}

function aOid(oidStr) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oidStr).getBytes());
}

function aNull() {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '');
}

function aSequence(children) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
}

function aSet(children) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, children);
}

function aContext(n, children) {
  return asn1.create(asn1.Class.CONTEXT_SPECIFIC, n, true, children);
}

function aOctets(bytes) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, bytes);
}

function aUtf8(str) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTF8, false, Buffer.from(str, 'utf8').toString('binary'));
}

function aBitString(bytes) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BITSTRING, false, '\x00' + bytes);
}

function aUtcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const value = pad(date.getUTCFullYear() % 100) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) +
    pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z';
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTCTIME, false, value);
}

function aRdn(attrs) {
  return aSequence(attrs.map((attr) => aSet([
    aSequence([aOid(OIDS[attr.name]), aUtf8(attr.value)])
  ])));
}

function derOf(node) {
  return Buffer.from(asn1.toDer(node).getBytes(), 'binary');
}

function parseAsn1(bytes) {
  return asn1.fromDer(forge.util.createBuffer(bytes.toString('binary'), 'binary'));
}

function pemDecode(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

function pemEncode(type, derBytes) {
  const body = Buffer.from(derBytes).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return '-----BEGIN ' + type + '-----\n' + body + '\n-----END ' + type + '-----\n';
}

function rsaPrivateKeyObject(privateKeyPem) {
  return crypto.createPrivateKey(privateKeyPem);
}

function rsaSignSha256(privateKeyObject, dataBuffer) {
  return crypto.sign('sha256', dataBuffer, privateKeyObject);
}

function readPemSetting(valueName, pathName) {
  const inlineValue = process.env[valueName];
  if (inlineValue) return inlineValue.replace(/\\n/g, '\n');
  const filePath = process.env[pathName];
  if (!filePath) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function splitCertificateChain(pem) {
  return String(pem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

/**
 * 读取 CA 签发的组织级 PDF 文档签名身份。
 * 未配置时返回 null，由部署程序准备独立稳定平台密钥；生产签署不得临时生成或降级。
 */
function getConfiguredSigningIdentity() {
  const privateKeyPem = readPemSetting('PDF_SIGNING_PRIVATE_KEY_PEM', 'PDF_SIGNING_PRIVATE_KEY_PATH');
  const certificatePem = readPemSetting('PDF_SIGNING_CERTIFICATE_PEM', 'PDF_SIGNING_CERTIFICATE_PATH');
  const certificateChainPem = readPemSetting('PDF_SIGNING_CERTIFICATE_CHAIN_PEM', 'PDF_SIGNING_CERTIFICATE_CHAIN_PATH');
  if (!privateKeyPem && !certificatePem && !certificateChainPem) return null;
  if (!privateKeyPem || !certificatePem) {
    throw new Error(localeCopy.copy_6350b591cd);
  }

  try {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const certificate = new crypto.X509Certificate(certificatePem);
    const privatePublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    if (!privatePublicKey.equals(certificatePublicKey)) {
      throw new Error(localeCopy.copy_6fa0204352);
    }
    const chain = splitCertificateChain(certificateChainPem)
      .filter((item) => item.trim() && item.trim() !== certificatePem.trim());
    return {
      privateKeyPem,
      publicKeyPem: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
      certificatePem,
      certificateChainPem: chain.join('\n'),
      trustStatus: chain.length ? 'chain_configured' : 'certificate_configured'
    };
  } catch (error) {
    throw new Error(localeCopy.copy_6350b591cd);
  }
}

/**
 * 读取内部 CA/父证书身份。该模式只适用于组织已经把父证书根加入阅读器信任库的场景。
 * 公共 CA 通常不会把文档签名叶证书的签发私钥交给业务系统。
 */
function getConfiguredParentSigningIdentity() {
  const privateKeyPem = readPemSetting('PDF_SIGNING_PARENT_PRIVATE_KEY_PEM', 'PDF_SIGNING_PARENT_PRIVATE_KEY_PATH');
  const certificatePem = readPemSetting('PDF_SIGNING_PARENT_CERTIFICATE_PEM', 'PDF_SIGNING_PARENT_CERTIFICATE_PATH');
  const chainPem = readPemSetting('PDF_SIGNING_PARENT_CHAIN_PEM', 'PDF_SIGNING_PARENT_CHAIN_PATH');
  if (!privateKeyPem && !certificatePem && !chainPem) return null;
  if (!privateKeyPem || !certificatePem) {
    throw new Error(localeCopy.copy_6350b591cd);
  }
  try {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const certificate = new crypto.X509Certificate(certificatePem);
    const privatePublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    if (!privatePublicKey.equals(certificatePublicKey)) {
      throw new Error(localeCopy.copy_515d8dc936);
    }
    return {
      privateKeyPem,
      certificatePem,
      chainPem
    };
  } catch (error) {
    throw new Error(localeCopy.copy_6350b591cd);
  }
}

// ── 密钥对与证书 ─────────────────────────────────────────────
function generateSigningKeyPair() {
  const keys = forge.pki.rsa.generateKeyPair(3072);
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey)
  };
}

/**
 * 生成自签名 X.509 v3 证书，CN 只允许姓名。旧学号参数仅保留调用兼容，不写入证书。
 */
function createSignerCertificate(privateKey, publicKey, signerName, studentId, orgName, issuerOptions) {
  const serialHex = '01' + crypto.randomBytes(15).toString('hex');
  const serialBytes = Buffer.from(serialHex, 'hex').toString('binary');
  const dnAttrs = [
    { name: 'commonName', value: signerName }
  ];
  if (orgName) dnAttrs.push({ name: 'organizationName', value: orgName });
  const rdn = aRdn(dnAttrs);
  let issuerRdn = rdn;
  let issuerPrivateKeyObject = rsaPrivateKeyObject(forge.pki.privateKeyToPem(privateKey));
  if (issuerOptions && issuerOptions.certificatePem && issuerOptions.privateKeyPem) {
    const issuerCertNode = parseAsn1(pemDecode(issuerOptions.certificatePem));
    issuerRdn = issuerCertNode.value[0].value[5];
    issuerPrivateKeyObject = rsaPrivateKeyObject(issuerOptions.privateKeyPem);
  }
  const now = new Date();
  const tbs = aSequence([
    aContext(0, [aInteger(2)]), // X.509 v3
    aIntegerBytes(serialBytes),
    aSequence([aOid(OIDS.sha256WithRSAEncryption), aNull()]),
    issuerRdn,
    aSequence([aUtcTime(new Date(now.getTime() - 5 * 60 * 1000)), aUtcTime(new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000))]),
    rdn, // subject
    forge.pki.publicKeyToAsn1(publicKey)
  ]);
  const tbsDer = derOf(tbs);
  const signature = rsaSignSha256(issuerPrivateKeyObject, tbsDer);
  const certDer = derOf(aSequence([
    tbs,
    aSequence([aOid(OIDS.sha256WithRSAEncryption), aNull()]),
    aBitString(signature.toString('binary'))
  ]));
  return pemEncode('CERTIFICATE', certDer);
}


function readDerPayloadLength(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return 0;
  const firstLengthByte = buffer[1];
  if ((firstLengthByte & 0x80) === 0) return 2 + firstLengthByte;
  const lengthByteCount = firstLengthByte & 0x7f;
  if (!lengthByteCount || lengthByteCount > 6 || buffer.length < 2 + lengthByteCount) return 0;
  let payloadLength = 0;
  for (let index = 0; index < lengthByteCount; index += 1) {
    payloadLength = payloadLength * 256 + buffer[2 + index];
  }
  const totalLength = 2 + lengthByteCount + payloadLength;
  return Number.isSafeInteger(totalLength) ? totalLength : 0;
}

function extractCmsDerFromPdfContents(pdfBuffer, byteRange) {
  if (!Buffer.isBuffer(pdfBuffer) || !Array.isArray(byteRange) || byteRange.length !== 4) return null;
  const contentsStart = Number(byteRange[0]) + Number(byteRange[1]);
  const contentsEnd = Number(byteRange[2]);
  if (!Number.isSafeInteger(contentsStart) || !Number.isSafeInteger(contentsEnd)
    || contentsStart < 0 || contentsEnd <= contentsStart || contentsEnd > pdfBuffer.length) return null;
  const rawContents = pdfBuffer.slice(contentsStart, contentsEnd).toString('ascii');
  const openIndex = rawContents.indexOf('<');
  const closeIndex = rawContents.lastIndexOf('>');
  if (openIndex < 0 || closeIndex <= openIndex) return null;
  const signatureHex = rawContents.slice(openIndex + 1, closeIndex).replace(/\s+/g, '');
  if (!signatureHex || signatureHex.length % 2 !== 0 || /[^0-9a-f]/i.test(signatureHex)) return null;
  const paddedDer = Buffer.from(signatureHex, 'hex');
  const derLength = readDerPayloadLength(paddedDer);
  if (!derLength || derLength > paddedDer.length) return null;
  return paddedDer.subarray(0, derLength);
}


module.exports = {
  generateSigningKeyPair,
  createSignerCertificate,
  signPdfBuffer: require('./pdfSignedDocument').signPdfBuffer,
  verifyPdfSignature: require('./pdfSignedDocument').verifyPdfSignature,
  pemDecode,
  getConfiguredSigningIdentity,
  getConfiguredParentSigningIdentity,
  extractCmsDerFromPdfContents
};
