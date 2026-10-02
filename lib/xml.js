/**
 * 极简 XML 解析器（零依赖）。
 *
 * 为什么不引第三方库：DSH 的 host 半边以纯 ESM 源码被加载，`svn` 插件的
 * 目标是「装好即用、不发 npm 依赖树」。而 `svn log --xml` / `svn status --xml`
 * 的输出是 Subversion 机器生成的、结构极稳定的 XML 子集，因此这里实现一个
 * 只覆盖该子集的解析器即可，不追求通用性：
 *
 *   · XML 声明 `<?xml ... ?>`、注释 `<!-- -->`  —— 跳过
 *   · 元素 / 自闭合元素 / 属性（单双引号都支持）
 *   · 文本与实体解码（&amp; &lt; &gt; &quot; &apos; &#NN; &#xNN;）
 *   · CDATA 段
 *   · 命名空间前缀原样保留（不展开），因为 svn 输出的元素基本无前缀
 *
 * 容错策略：遇到格式错误**不抛异常**，而是尽力返回已解析的部分，并通过
 * `errors` 数组回报。理由——解析失败时 UI 应显示「空日志 + 原因」而不是
 * 整块面板崩掉；svn 偶尔会在 XML 前后混入本地化告警文本。
 */

/** 解码 XML 实体。 */
function decodeEntities(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return '\u00a0';
      default: return whole;
    }
  });
}

/** 扫描一个标签，返回 { name, attrs, selfClosing, end }。 */
function readTag(text, start) {
  const end = text.indexOf('>', start);
  if (end === -1) return null;
  let inner = text.slice(start + 1, end);
  let selfClosing = false;
  if (inner.endsWith('/')) {
    selfClosing = true;
    inner = inner.slice(0, -1);
  }
  const match = /^([^\s/>]+)/.exec(inner);
  if (match === null) return null;
  const name = match[1];
  const attrs = Object.create(null);
  const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attrRe.exec(inner.slice(match[0].length))) !== null) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return { name, attrs, selfClosing, end: end + 1 };
}

/**
 * 解析 XML 文本。
 * @param {string} text
 * @returns {{root: object | null, errors: string[]}}
 *   节点形状：`{name, attrs, children, text}`，`children` 为元素数组，
 *   `text` 为该元素下所有直接文本拼接（已解码、已 trim）。
 */
export function parseXml(text) {
  const errors = [];
  if (typeof text !== 'string' || text.trim() === '') return { root: null, errors };
  // svn 有时在 XML 前打印本地化告警（例如证书警告），定位到第一个 '<'
  const firstLt = text.indexOf('<');
  const source = firstLt > 0 ? text.slice(firstLt) : text;

  const root = { name: '#document', attrs: Object.create(null), children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      accumulate(stack[stack.length - 1], source.slice(i));
      break;
    }
    if (lt > i) accumulate(stack[stack.length - 1], source.slice(i, lt));

    if (source.startsWith('<?', lt)) {
      const close = source.indexOf('?>', lt);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt);
      i = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt);
      const raw = close === -1 ? source.slice(lt + 9) : source.slice(lt + 9, close);
      accumulate(stack[stack.length - 1], raw, true);
      i = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const close = source.indexOf('>', lt);
      if (close === -1) { errors.push('未闭合的结束标签'); break; }
      const name = source.slice(lt + 2, close).trim();
      // 弹栈到同名元素；名字不匹配时记录但继续（容错）
      let depth = stack.length - 1;
      while (depth > 0 && stack[depth].name !== name) depth -= 1;
      if (depth === 0) errors.push(`多余的结束标签 </${name}>`);
      else stack.length = depth;
      i = close + 1;
      continue;
    }
    if (source.startsWith('<!', lt)) { // DOCTYPE 等，整段跳过
      const close = source.indexOf('>', lt);
      i = close === -1 ? source.length : close + 1;
      continue;
    }

    const tag = readTag(source, lt);
    if (tag === null) { errors.push('标签未闭合'); break; }
    const node = { name: tag.name, attrs: tag.attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!tag.selfClosing) stack.push(node);
    i = tag.end;
  }
  if (stack.length > 1) errors.push(`未闭合的元素：${stack.slice(1).map((n) => n.name).join(' > ')}`);

  const rootElement = root.children.find((child) => child.name !== '#text') ?? null;
  return { root: rootElement, errors };
}

/** 把一段文本累加到节点的 text 上（可选强制原文，用于 CDATA）。 */
function accumulate(node, chunk, raw = false) {
  if (chunk === '') return;
  node.text += raw ? chunk : decodeEntities(chunk);
}

/** 取第一个指定名字的直接子元素。 */
export function childOf(node, name) {
  if (node === null || node === undefined) return null;
  return node.children.find((child) => child.name === name) ?? null;
}

/** 取指定名字直接子元素的文本（不存在时返回 ''）。 */
export function textOf(node, name) {
  const child = childOf(node, name);
  return child === null ? '' : child.text.trim();
}

/** 取所有指定名字的直接子元素。 */
export function childrenOf(node, name) {
  if (node === null || node === undefined) return [];
  return node.children.filter((child) => child.name === name);
}
