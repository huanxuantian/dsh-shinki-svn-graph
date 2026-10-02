/**
 * xml.js 单测：svn 的 --xml 输出是机器生成的稳定子集，解析器必须容错
 * （畸形输入返回部分结果 + errors，而不是抛异常炸掉整个面板）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, childOf, textOf, childrenOf } from '../lib/xml.js';

test('解析 log --xml 的典型结构', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="2803">
<author>alice</author>
<date>2026-10-02T15:41:29.660454Z</date>
<paths>
<path action="A" kind="file" text-mods="false" prop-mods="false">/group/sub/PROJ-A/proja/x.bin</path>
</paths>
<msg>更新 PROJ-A proja 固件 v000018</msg>
</logentry>
</log>`;
  const { root, errors } = parseXml(xml);
  assert.equal(errors.length, 0);
  assert.equal(root.name, 'log');
  const entry = childrenOf(root, 'logentry')[0];
  assert.equal(entry.attrs.revision, '2803');
  assert.equal(textOf(entry, 'author'), 'alice');
  assert.equal(textOf(entry, 'msg'), '更新 PROJ-A proja 固件 v000018');
  const p = childrenOf(childOf(entry, 'paths'), 'path')[0];
  assert.equal(p.attrs.action, 'A');
  assert.equal(p.text.trim(), '/group/sub/PROJ-A/proja/x.bin');
});

test('自闭合元素与多行 msg', () => {
  const xml = `<log><logentry revision="1"><author/><msg>第一行
第二行</msg></logentry></log>`;
  const { root } = parseXml(xml);
  const entry = childrenOf(root, 'logentry')[0];
  assert.equal(textOf(entry, 'author'), '');
  assert.equal(textOf(entry, 'msg'), '第一行\n第二行');
});

test('实体解码', () => {
  const xml = '<a><b>x &amp; y &lt;z&gt; &quot;q&quot; &#65;&#x42;</b></a>';
  const { root } = parseXml(xml);
  assert.equal(textOf(root, 'b'), 'x & y <z> "q" AB');
});

test('CDATA 段', () => {
  const xml = '<a><b><![CDATA[<not-a-tag> & raw]]></b></a>';
  const { root } = parseXml(xml);
  assert.equal(textOf(root, 'b'), '<not-a-tag> & raw');
});

test('XML 前混入本地化告警文本时仍能解析', () => {
  const { root, errors } = parseXml('svn: 警告: 某证书问题\n<?xml version="1.0"?><status><target path="."/></status>');
  assert.equal(errors.length, 0);
  assert.equal(root.name, 'status');
});

test('未闭合元素：返回部分结果并报告错误，不抛异常', () => {
  const { root, errors } = parseXml('<a><b>text');
  assert.notEqual(root, null);
  assert.ok(errors.length > 0, '未闭合元素必须被报告');
  assert.match(errors.join(' '), /未闭合/);
});

test('结束标签跨层匹配（容错而非报错）', () => {
  // svn 不会产出这种结构，但容错策略是"弹到同名祖先"，不应崩。
  const { root } = parseXml('<a><b>text</a>');
  assert.equal(root.name, 'a');
});

test('空输入与非法输入', () => {
  assert.deepEqual(parseXml(''), { root: null, errors: [] });
  assert.deepEqual(parseXml('   '), { root: null, errors: [] });
  assert.equal(parseXml('<a/>').root.name, 'a');
});

test('同名兄弟元素全部保留', () => {
  const { root } = parseXml('<status><target path="a"/><target path="b"/></status>');
  assert.deepEqual(childrenOf(root, 'target').map((t) => t.attrs.path), ['a', 'b']);
});
