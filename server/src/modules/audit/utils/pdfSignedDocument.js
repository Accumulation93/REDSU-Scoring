'use strict';

const { PDFDocument, PDFSignature, PDFName, PDFRef } = require('pdf-lib');
const { SignPdf } = require('@signpdf/signpdf');
const { Signer } = require('@signpdf/utils');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { signCms, verifyCms, MAX_CMS_BYTES } = require('./cmsSignature');
const { MAX_FILE_BYTES, sha256, fail } = require('./signingProtocol');

class EvidencePdfSigner extends Signer {
  constructor(identity, createManifest) { super(); this.identity = identity; this.createManifest = createManifest; }
  async sign(bytes) {
    const manifest = this.createManifest ? await this.createManifest(bytes) : null;
    return signCms(bytes, this.identity, { manifest });
  }
}

async function signPdfBuffer(buffer, privateKeyPem, certificatePem, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FILE_BYTES) fail('pdf_size_invalid');
  const doc = await PDFDocument.load(buffer, { updateMetadata: false });
  const form = doc.getForm();
  const previousSignatures = form.getFields().filter(field => field instanceof PDFSignature);
  if (previousSignatures.length) {
    // 新轮次产生独立文件版本：保留表单可视外观，移除已失效的旧签名域。
    // 原字节由文件提交协调器和凭证引用保留，不把重排后的旧签名伪装成有效。
    const values = previousSignatures.map(field => field.acroField.dict.get(PDFName.of('V')));
    form.flatten({ updateFieldAppearances: false });
    values.forEach(ref => { if (ref instanceof PDFRef) doc.context.delete(ref); });
    doc.catalog.delete(PDFName.of('Perms'));
  }
  const position = options.signaturePosition;
  let widgetRect;
  let pdfPage;
  if (position) {
    const page = doc.getPages()[Math.max(0, Math.min(doc.getPageCount() - 1, (Number(position.page) || 1) - 1))];
    pdfPage = page;
    const size = page.getSize();
    const x = Math.min(1, Math.max(0, Number(position.x) || 0)) * size.width;
    const y = (1 - Math.min(1, Math.max(0, Number(position.y) || 0))) * size.height;
    widgetRect = [x, y, Math.min(size.width, x + 1), Math.min(size.height, y + 1)];
  }
  // 清单实际大小不可超过协议上限；签名空间在 ByteRange 确定前分配，禁止签署后扩容。
  const signatureLength = options.createManifest ? (options.signatureCapacity || MAX_CMS_BYTES) : 16384;
  if (!Number.isInteger(signatureLength) || signatureLength < 16384 || signatureLength > MAX_CMS_BYTES) fail('cms_size_invalid');
  pdflibAddPlaceholder({ pdfDoc: doc, reason: 'WHUSU platform attestation', contactInfo: '',
    name: 'WHUSU Smart Workspace', location: '',
    signatureLength, subFilter: 'adbe.pkcs7.detached', ...(widgetRect ? { widgetRect, pdfPage } : {}) });
  const prepared = Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
  if (prepared.length > MAX_FILE_BYTES) fail('pdf_size_invalid');
  const signed = await new SignPdf().sign(prepared, new EvidencePdfSigner({ privateKeyPem, certificatePem,
    certificateChainPem: options.certificateChainPem || '' }, options.createManifest));
  // 保存前复验最终字节，任何签名/占位/签后追加错误都不能进入文件提交事务。
  const checked = verifyPdfSignature(signed);
  if (!checked.valid || checked.signatures.length !== 1 || !checked.signatures[0].certificateBound
    || (options.createManifest && !checked.signatures[0].manifest)) fail('pdf_generated_signature_invalid');
  return signed;
}

function derPayload(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x30) fail('cms_structure_invalid');
  let len = bytes[1];
  let header = 2;
  if (len & 128) {
    const count = len & 127;
    if (!count || count > 4 || bytes.length < 2 + count) fail('cms_length_invalid');
    len = 0;
    for (let i = 0; i < count; i += 1) len = len * 256 + bytes[header++];
  }
  if (header + len > bytes.length || bytes.subarray(header + len).some(byte => byte !== 0)) fail('cms_padding_invalid');
  return bytes.subarray(0, header + len);
}

function verifyPdfSignature(buffer) {
  const signatures = [];
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FILE_BYTES || !buffer.subarray(0, 8).toString('ascii').startsWith('%PDF-')) fail('pdf_format_invalid');
    const text = buffer.toString('latin1');
    const ranges = [...text.matchAll(/\/ByteRange\s*\[([^\]]*)\]/g)];
    if (ranges.length > 32) fail('pdf_signature_limit');
    for (const match of ranges) {
      if (!/^\s*\d+\s+\d+\s+\d+\s+\d+\s*$/.test(match[1])) fail('pdf_byte_range_invalid');
      const range = match[1].trim().split(/\s+/).map(Number);
      const [start, firstLength, secondStart, secondLength] = range;
      if (!range.every(Number.isSafeInteger) || start !== 0 || firstLength <= 0
        || secondStart <= firstLength || secondLength <= 0 || secondStart + secondLength > buffer.length
        || match.index + match[0].length >= firstLength) fail('pdf_byte_range_invalid');
      const gap = text.slice(firstLength, secondStart);
      if (!/^<[a-fA-F0-9]+>$/.test(gap) || (gap.length - 2) % 2
        || !/\/Contents\s*$/.test(text.slice(Math.max(0, firstLength - 40), firstLength))) fail('pdf_contents_invalid');
      const cms = derPayload(Buffer.from(gap.slice(1, -1), 'hex'));
      const signedBytes = Buffer.concat([buffer.subarray(0, firstLength), buffer.subarray(secondStart, secondStart + secondLength)]);
      const result = verifyCms(cms, signedBytes);
      const wholeDocument = secondStart + secondLength === buffer.length;
      signatures.push({ ...result, content: undefined, certificatePem: undefined,
        byteRange: range, cmsValid: result.ok, signedBytesDigest: sha256(signedBytes), wholeDocument,
        ok: result.ok && wholeDocument,
        reasonCode: !wholeDocument ? 'pdf_modified_after_signing' : result.reasonCode });
    }
    return { present: signatures.length > 0, valid: signatures.length > 0 && signatures.every(item => item.ok),
      trusted: false, signatures, reasonCode: signatures.length ? 'pdf_checked' : 'pdf_unsigned' };
  } catch (error) {
    return { present: signatures.length > 0 || Boolean(buffer && buffer.includes('/ByteRange')), valid: false,
      trusted: false, signatures, reasonCode: error.code || 'pdf_structure_invalid' };
  }
}

module.exports = { signPdfBuffer, verifyPdfSignature };
