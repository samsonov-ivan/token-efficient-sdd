import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin each published reviewer's key independently of the input directory.
const cases = [
  [
    'max-f0-repeat-first-f1f8742-1-base-a1',
    'dbf037fde0a674160049ad3e9ef38962174d86b9573f9b0e0d66c246686b1ce4',
  ],
  [
    'csv-s-b0-f1f8742-1-base-a1',
    '8862ac54d55a4edca619e2b45d8fc07cf20e3f5668c5e9d068cda3fbd693b88e',
  ],
];

function verifyReceipt(dir, run, keyHash) {
  function requireEvidence(condition, message) {
    if (!condition) throw new Error(`${run}: ${message}`);
  }
  function read(suffix) {
    const file = join(dir, `${run}-${suffix}`);
    requireEvidence(lstatSync(file).isFile(), `требуется обычный файл ${suffix}`);
    return readFileSync(file);
  }

  const receipt = JSON.parse(read('quality.json'));
  const quality = receipt.signed_quality;
  function artifact(name) {
    const bytes = read(name);
    const digest = createHash('sha256').update(bytes).digest('hex');
    requireEvidence(quality.files[name] === `${run}-${name}`, `неверное имя ${name}`);
    requireEvidence(digest === quality.artifact_sha256[name], `не совпадает SHA-256 ${name}`);
    if (name === 'reviewer.pem')
      requireEvidence(digest === keyHash, 'не совпадает ключ проверяющего');
    return bytes;
  }
  const assessment = artifact('assessment.json');
  const signature = artifact('assessment.sig');
  const key = createPublicKey(artifact('reviewer.pem'));
  requireEvidence(
    key.asymmetricKeyType === 'ed25519' && quality.signature === 'Ed25519',
    'ожидается Ed25519',
  );
  requireEvidence(verify(null, assessment, key, signature), 'подпись Ed25519 недействительна');

  const signed = JSON.parse(assessment);
  requireEvidence(receipt.run_id === run && signed.run_id === run, 'не совпадает run_id');
  for (const field of ['final_commit', 'final_tree', 'manifest_sha256', 'request_sha256']) {
    const format = field.startsWith('final_') ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    requireEvidence(
      format.test(signed[field]) && signed[field] === receipt[field],
      `не совпадает ${field}`,
    );
  }
  requireEvidence(
    signed.semantic.some((row) => row.verdict === 'fail') &&
      quality.passed === false &&
      receipt.accepted === false,
    'не подтверждён опубликованный отказ QA',
  );

  const meter = receipt.meter_replay;
  const stages = ['apply', 'review', 'spec', 'verify'];
  requireEvidence(
    Object.keys(meter.by_stage).sort().join(',') === stages.join(','),
    'не совпадает состав стадий',
  );
  for (const field of ['model_calls', 'rpt']) {
    let total = 0;
    for (const stage of stages) {
      const value = meter.by_stage[stage][field];
      requireEvidence(Number.isSafeInteger(value) && value >= 0, `некорректное ${stage}.${field}`);
      total += value;
    }
    requireEvidence(
      Number.isSafeInteger(total) && total === meter[field],
      `не совпадает сумма стадий ${field}`,
    );
  }
  return `${run} — приёмка отклонила снимок. Вызовы модели — ${meter.model_calls}, RPT — ${meter.rpt}`;
}

try {
  if (process.argv.length > 3)
    throw new Error('Использование: node scripts/verify-public-receipts.mjs [SUMMARY_DIR]');
  const dir = process.argv[2] ?? fileURLToPath(new URL('../bench/runs/summary/', import.meta.url));
  const results = cases.map(([run, keyHash]) => verifyReceipt(dir, run, keyHash));
  console.log(results.join('\n'));
  console.log(
    'Проверены подписи QA (Ed25519), привязка к снимкам и арифметика опубликованных агрегатов.',
  );
  console.log('Сырые события живых прогонов и KPI экономии в этом наборе недоступны.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
