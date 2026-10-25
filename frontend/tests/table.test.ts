import { test } from 'vitest';
import assert from 'node:assert/strict';
import { quotaSortKey, sortRows, displayField, sourceDisplay } from '../src/domain/table';

test('descending quota order separates unlimited, unconditional, conditional, stopped, unavailable and unknown', () => {
  const values = ['待更新', '100（部分渠道）', '5千', '暂停', '无', '1万', '10→5', '不限额', '100', '0', '部分渠道2千', '1,000', ''];
  const rows = values.map((distributorLimit, id) => ({ id, distributorLimit }));
  const result = sortRows(rows);
  assert.deepEqual(result.map(row => row.distributorLimit),
    ['不限额', '1万', '5千', '1,000', '100', '部分渠道2千', '100（部分渠道）', '10→5', '暂停', '0', '无', '待更新', '']);
  assert.deepEqual(rows.map(row => row.distributorLimit), values, 'sorting does not mutate the API snapshot');
  assert.equal(result.find(row => row.id === 1), rows[1], 'the original conditional text and row object survive');
});

test('unit, decimal and correctly grouped values compare as exact cents', () => {
  for (const [value, amount] of [['0.01万', 10_000n], ['5千元/日', 500_000n], ['￥1,234.56元／天', 123_456n],
    ['人民币 1．25 万元', 1_250_000n], ['1，000', 100_000n], ['90071992547409.91', 9_007_199_254_740_991n]] as const) {
    assert.deepEqual(quotaSortKey(value), { bucket: 1, amount }, value);
  }
  assert.deepEqual(sortRows(['100', '1百说明', '100元', '0.1千', '0.01万'].map((distributorLimit, id) => ({ id, distributorLimit }))).map(row => row.id), [0, 2, 3, 4, 1]);
});

test('stable ties include alternative amount representations, stopped/zero and unknown buckets', () => {
  const values = ['不限', '无限额', '1千', '1,000.00元', '1000', '100*', '部分渠道100', '暂停申购', '0.00万', '暂停', '无代销', '未销售', '未知', '—', '-'];
  const rows = values.map((distributorLimit, id) => ({ id, distributorLimit }));
  assert.deepEqual(sortRows(rows), rows);
  assert.equal(quotaSortKey('0').bucket, 3);
});

test('a conditional amount is never promoted to an unconditional amount', () => {
  for (const value of ['100*', '100†', '部分渠道100', '100（部分渠道）']) {
    assert.deepEqual(quotaSortKey(value), { bucket: 2, amount: 10_000n });
  }
  assert.deepEqual(quotaSortKey('0（仅部分渠道）'), { bucket: 2, amount: 0n });
  assert.equal(quotaSortKey('部分渠道不限额').bucket, 2);
});

test('ranges, transitions, foreign currencies, malformed and ambiguous numbers never get guessed', () => {
  const values = ['10→5', '10->5', '100至500', '100~500', '合并100', '共享额度100', '分别100', '代码019441额度100',
    '100美元', '$100', 'HKD100', '-100', '12,34', '1.234', '1e3', '90071992547409.92',
    '.5', '100.', '部分渠道.5', '100%', '100％', '100（10月25日生效）'];
  for (const value of values) assert.deepEqual(quotaSortKey(value), { bucket: 2, amount: null }, value);
});

test('field labels preserve actual pending values and source rows do not claim every field won a vote', () => {
  for (const value of [null, undefined, '', '待更新']) assert.equal(displayField(value), '待更新');
  assert.equal(displayField('100*'), '100*');
  assert.deepEqual(sourceDisplay({ authorId: 'test-author', status: 'partial', rowCount: 41, errorCode: 'SOURCE_PARTIAL_FIELDS' }),
    { data: '提供 41 行投票数据', issue: '' });
  assert.deepEqual(sourceDisplay({ authorId: 'test-author', status: 'failed', rowCount: 10, errorCode: 'SOURCE_EXTRACTION_FAILED' }),
    { data: '提供 10 行投票数据', issue: '存在转录失败' });
  assert.equal(sourceDisplay({ authorId: 'test-author', status: 'unknown', rowCount: null }).data, '本轮未提供投票数据');
});
