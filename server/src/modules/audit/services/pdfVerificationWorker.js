'use strict';

const { parentPort, workerData } = require('worker_threads');
const { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFHexString } = require('pdf-lib');
const { verifyPdfSignature } = require('../utils/pdfSignedDocument');
const { fail } = require('../utils/signingProtocol');

async function inspect(bytes) {
  const result = verifyPdfSignature(bytes);
  if (!result.present || !result.valid) return result;
  // 不能仅在字节流里搜到 ByteRange 就把注释或脱离表单的字典认作有效签名对象。
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = form && form.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) fail('pdf_signature_object_missing');
  const visited = new Set();
  const ranges = new Set();
  function walk(array, depth, inheritedType) {
    if (depth > 24 || visited.size > 4096) fail('pdf_structure_limit');
    for (let i = 0; i < array.size(); i += 1) {
      const field = array.lookup(i, PDFDict);
      if (visited.has(field)) fail('pdf_field_cycle');
      visited.add(field);
      const type = field.lookupMaybe(PDFName.of('FT'), PDFName) || inheritedType;
      const value = field.lookup(PDFName.of('V'));
      if (type && type.toString() === '/Sig' && value) {
        if (!(value instanceof PDFDict) || value.lookup(PDFName.of('Type')).toString() !== '/Sig') fail('pdf_signature_object_invalid');
        const range = value.lookup(PDFName.of('ByteRange'), PDFArray);
        const contents = value.lookup(PDFName.of('Contents'), PDFHexString);
        if (range.size() !== 4) fail('pdf_byte_range_invalid');
        const numbers = Array.from({ length: 4 }, (_, n) => range.lookup(n, PDFNumber).asNumber());
        const key = numbers.join(',');
        if (ranges.has(key)) fail('pdf_signature_object_duplicate');
        ranges.add(key);
        const gap = bytes.subarray(numbers[1] + 1, numbers[2] - 1).toString('ascii');
        if (!Buffer.from(contents.asBytes()).equals(Buffer.from(gap, 'hex'))) fail('pdf_contents_invalid');
        if (!result.signatures.some(item => item.byteRange.join(',') === key)) fail('pdf_signature_object_mismatch');
      }
      const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
      if (kids) walk(kids, depth + 1, type);
    }
  }
  walk(fields, 0, null);
  if (ranges.size !== result.signatures.length) fail('pdf_signature_object_mismatch');
  return result;
}

inspect(Buffer.from(workerData)).then(result => parentPort.postMessage(result)).catch(error => {
  parentPort.postMessage({ present: true, valid: false, signatures: [], trusted: false,
    reasonCode: error.code || 'pdf_structure_invalid' });
});
